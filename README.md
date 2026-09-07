# 版权合规方案 · 开源骨架

面向「离线文档/软件版权保护」的通用实现骨架，聚焦两大核心机制：

- **版权校验（设备激活上限）**：控制同一份内容允许绑定的活跃设备数，从数据库/存储层杜绝并发绕过。
- **电子签（哈希存证）**：协议正文与签署信息以**原文存储**，同时生成 SHA-256 哈希绑定，实现防篡改与可核验。

纯 TypeScript 实现，**零第三方运行时依赖**，可嵌入任意后端（Node / Postgres / RDB / KV）。

> 本项目仅开源**通用机制骨架**，不含任何业务字段、密钥、个人身份信息或具体协议条款。

## 架构

```
┌────────────────────────────────────────────┐
│                业务层（宿主系统）            │
│   你主导的：文件元数据 / 用户 / 订单 / 权限  │
└────────────────────────────────────────────┘
        │ 接入以下两个纯逻辑模块
        ▼
┌────────────────────────┐   ┌──────────────────────────┐
│ copyright/device       │   │ esign（电子签哈希存证）     │
│ 设备激活上限 · 原子并发  │   │ 正文+签名图 → SHA-256 存根  │
└────────────────────────┘   └──────────────────────────┘
        ▲                              ▲
        │       可替换的持久化适配层        │
        ▼                              ▼
  你的 RDB / Redis / KV / 云DB       你的存储 + 简单账本
```

两个模块只依赖调用方注入的**读写回调**，不绑定特定数据库，保证可移植、可测试。

## 核心模块

### `devices.ts` — 设备激活上限（原子并发控制）

防止同一份离线内容被破解为「无限设备可激活」，核心是解决并发下计数错乱的经典竞态。

```ts
const guard = new DeviceQuotaGuard(3); // 最多 3 台活跃设备

// 激活回调：drain(锁住file) / readActive(读当前活跃数) / insert(写入激活)
const r = await guard.activate(
  async () => { await lockFile('doc-1'); },      // 串行化同一文件的并发激活
  async () => countActive('doc-1'),               // 锁内重查
  async (dev) => insertActivation('doc-1', dev),  // 未满才写入
);

if (r.code === 'ACTIVATED')     { /* 新设备激活成功 */ }
if (r.code === 'DEVICE_ALREADY'){ /* 同设备幂等复用 token */ }
if (r.code === 'DEVICE_LIMIT')  { /* 已达上限，拒绝 */ }
```

设计要点：

- **锁外乐观放行的误区**：若只在锁外先查计数再插入，并发请求会同时读到旧值→ 一起通过 → 突破上限。
- **正确范式**：为同一授权对象加**排他锁**（数据库行锁 / `SELECT ... FOR UPDATE` / Redis 分布式锁 / advisory lock），在锁内**重新读取**当前活跃数，未满才插入，并依赖「文件↔设备」唯一索引兜底。
- **幂等**：同一设备重复激活，复用已签发 token，不新增记录。
- 通过回调注入持久化，天然适配多种存储。

### `esign.ts` — 电子签哈希存证（原文存储 + 防篡改）

协议签署的「不可抵赖」不靠封存明文，而靠**哈希绑定**：

- **原文存储**：协议正文、签署者姓名、签名图像等均以原文落库，作为完整可读证据（司法作证需要）。
- **哈希存根**：对「同意凭据 + 签署时间 + 协议正文哈希」做 SHA-256，生成不可逆签名哈希。内容被篡改 → 哈希对不上 → 可证伪。

```ts
// 正文防篡改：内容哈希
const contentHash = await sha256Hex(agreementText); // 绑定到协议版本

// 同意凭据：勾选同意 = 正文哈希的绑定承诺
const consentSig = await consentDigest(agreementVersion, contentHash, signedAt);

// 手写签名图同样纳入哈希（若有）
const sigHash = await signatureDigest(consentSig, signatureImageBase64 || '');

// 随机防重 token（激活/签署记录唯一标识）
const token = randomToken('ACT', 4);
```

设计要点：

- **正文原文存储 + 内容哈希**双轨：数据库存 `agreement_versions`（原文模板）与 `signing_records`（原文签名图 + 哈希），哈希不牺牲可读证据。
- **哈希链**：同意 → 正文 → 签名图逐层绑定，任一环节被改都可检测。
- 与设备上限解耦：即使设备数达标，签署存证逻辑独立可复用。

## 快速开始

骨架库零运行时依赖，直接安装类型即可运行示例：

```bash
pnpm install
pnpm tsx examples/demo.ts   # 运行设备上限 + 电子签演示
```

示例输出：严格限制 3 台设备（第 4 台被拒）、同设备幂等复用、正文/签名哈希存证均为原文可核验。

## 本地构建

```bash
pnpm install               # 安装 typescript / tsx / @types/node（仅开发期）
pnpm run build             # tsc 编译 → dist/（供产物发布）
npx tsx examples/demo.ts   # 直接运行示例
```

构建产物为干净 ESM，可在宿主工程中以源码或打包后引用。

## 部署方案

骨架库**零第三方运行时依赖**，以「调用方注入读写回调」的方式接入任何后端。下面按存储选型给出标准部署范式。

### 方式 A：PostgreSQL（推荐，兼并发安全最稳）

设备上限与签署记录落在同一事务，用 **行锁**串行化同一文件的激活（比咨询锁更可靠，见 `devices.ts` 注释）。

```sql
-- 1) 授权配置表（兼作行锁锚点）
CREATE TABLE activation_configs (
  file_id     text PRIMARY KEY,
  max_devices int  NOT NULL DEFAULT 3
);

-- 2) 激活记录表（含唯一索引兜底幂等）
CREATE TABLE file_activations (
  file_id    text NOT NULL,
  device_id  text NOT NULL,
  machine_id text,
  token      text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, device_id)
);

-- 3) 签署存证表（原文 + 哈希绑定）——与电子签搭配
CREATE TABLE signing_records (
  file_id        text NOT NULL,
  device_id      text NOT NULL,
  agreement_id   uuid,          -- 关联协议版本
  signer_name    text,          -- 原文
  signature_image text,          -- 签名图原文(base64)
  signature_hash  text NOT NULL, -- SHA-256 存根
  ip             text,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, device_id)
);
```

服务端激活事务（示意，事务内串行）：

```ts
// Postgres 客户端在单一事务内依次：
await pool.query('BEGIN');
await pool.query(/* drain */ `
  INSERT INTO activation_configs(file_id,max_devices) VALUES($1,3)
  ON CONFLICT (file_id) DO NOTHING`);
await pool.query('SELECT 1 FROM activation_configs WHERE file_id=$1 FOR UPDATE', [fileId]); // 行锁

const active = await pool.query(
  `SELECT count(*) FROM file_activations WHERE file_id=$1 AND is_active`, [fileId]);
// active < max 则 INSERT，否则返回 DEVICE_LIMIT

await pool.query('INSERT ... ON CONFLICT (file_id,device_id) DO NOTHING'); // 幂等
await pool.query('COMMIT');
```

关键点：

- **行锁串行化** `FOR UPDATE` 让同一 `file_id` 的并发激活逐个进入临界区，锁内 `count` 必然最新 → 并发下严格封顶。
- **唯一索引兜底** `(file_id, device_id)` 保证同设备绝不重复激活。
- **签署与激活同事务**：激活成功必留签署记录，失败整体回滚（无漏档）。

### 方式 B：Redis / 单机内存（轻量场景）

用 Redis 分布式锁（`SETNX`/`Redlock`）或单节点内存互斥，锁内 `readActive→compare→insert`：

```ts
import { createClient } from 'redis';

// drain：分布式锁（仅示例，生产用成熟锁实现）
const drainForFile = async (fileId: string) => {
  for (;;) {
    const ok = await redis.set(`lock:${fileId}`, '1', { NX: true, EX: 10 });
    if (ok) return;
    await sleep(30);
  }
};
const readActive = async (fileId: string) =>
  Number(await redis.get(`active:${fileId}`) ?? 0);
const insert = async (fileId: string, deviceId: string) =>
  redis.sAdd(`devices:${fileId}`, deviceId);

// 委托给 DeviceQuotaGuard
```

- 适合单实例或低一致性要求的场景；多副本建议 `Redlock` 并容忍极端下的短暂超限。

### 方式 C：作为 npm 子包（`@qinglvsenlin/copyright-compliance`）

```bash
# 在宿主工程内
pnpm add @qinglvsenlin/copyright-compliance   # 本地调试可 pnpm add ../qinglvsenlin-copyright
```

```ts
import { DeviceQuotaGuard, sha256Hex, consentDigest, signatureDigest } from '@qinglvsenlin/copyright-compliance';
```

### 部署生产清单

- [ ] 数据库唯一索引 + 行锁（Postgres 方案）已建
- [ ] `max_devices` 走配置表，勿硬编码（便于运营调整）
- [ ] 激活用 HTTPS，签署记录记录 `ip` 增强审计
- [ ] `content_hash` 绑定协议版本，正文被改即检测
- [ ] 授权回调域名/来源校验，防越权签发
- [ ] 归档策略：案件已归档且超期限后才清理映射/激活，云端备份保留

## 许可

[Apache License 2.0](./LICENSE)