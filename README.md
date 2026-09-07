# 版权合规方案 · 开源骨架

面向「离线文档/软件版权保护」的通用实现骨架，聚焦两大核心机制：

- **版权校验（设备激活上限）**：控制同一份内容允许绑定的活跃设备数，从数据库/存储层杜绝并发绕过。
- **电子签（哈希存证）**：协议正文与签署信息以**原文存储**，同时生成 SHA-256 哈希绑定，实现防篡改与可核验。

纯 TypeScript 实现，**零第三方运行时依赖**，可嵌入任意后端（Node / Postgres / RDB / KV）。


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

## 核心特性

面向版权保护的真实业务场景，这个骨架不仅给出机制，还沉淀了踩坑后的**正确范式**：

- **并发严格封顶，杜绝竞态突破**：先加排他锁、锁内重查再写入，配合「文件↔设备」唯一索引兜底，从存储层彻底杜绝「并发同时通过破上限」的经典攻击。
- **双重幂等**：同一设备重复激活，复用已签发 token，不产生冗余激活记录与签署记录。
- **存储无关，可移植可测试**：设备上限只依赖注入的 `drain / readActive / insert` 三个回调；电子签只依赖 `sha256`——不绑定数据库，Postgres / Redis / KV / 云 DB 皆可接入。
- **天然可审计**：签署记录记录 `ip`、时间、协议版本、内容哈希，形成可回溯的完整证据链。
- **与业务解耦**：版权校验与电子签独立成模块，可单独用其一，也可组合；不依赖宿主系统的订单、用户、权限模型。

## 功能总览

`qinglvsenlin-copyright` 提供**版权校验**与**电子签哈希存证**两大通用能力。二者相互独立、可单独使用，也可组合成一套完整的「授权 → 存证」底座。

### 1. `DeviceQuotaGuard` — 设备激活上限（版权保护核心）

防止一个授权文件被无限复制、在多台设备上无限激活。

| 能力 | 说明 |
| --- | --- |
| **激活上限** | 单个授权对象（文件/账号/文档）最多可同时在 `N` 台设备激活，超出即拒绝。 |
| **并发封顶（关键）** | 正确的加锁范式：同一对象先加**排他锁**（行锁/`FOR UPDATE`/分布式锁），在**锁内重读**当前活跃数，未满才写入；配合「对象↔设备」唯一索引兜底，从存储层杜绝「并发同时读到旧值→集体突破上限」的经典攻击。 |
| **幂等复用** | 同一设备重复激活，返回已签发 token，不新增激活/签署冗余记录。 |
| **可审计激活信息** | 记录设备标识、机器指纹、签发时间，形成激活台账，支持追溯与吊销。 |
| **存储无关** | 只依赖注入的 `drain（加锁） / readActive（读取） / insert（写入）` 三个回调，与具体数据库解耦。 |

**典型场景**：软件/课程/文档的授权许可控制——一个授权码只允许注册 N 台设备，防止密钥被随意转售、共享。

### 2. `esign` — 电子签哈希存证（不可抵赖）

让「谁在什么时间同意了什么内容」可被可信验证，而不用封存干扰阅读的密文。

| 能力 | 说明 |
| --- | --- |
| **原文存储** | 协议正文、签署者姓名、手写签名图像均以**原文**落库，完整可读，可直接作为司法/商务证据。 |
| **哈希防篡改** | 对「同意凭据 + 签署时间 + 协议正文哈希」做 SHA-256，生成不可逆签名哈希；内容被改动 → 哈希对不上 → 可证伪。 |
| **哈希链绑定** | `同意 → 正文 → 签名图`逐层哈希绑定，任一环节被篡改都能被检测。 |
| **内容哈希绑定版本** | 正文先算 `content_hash` 并绑定协议版本，协议升级/正文变更即暴露。 |
| **加密级随机 token** | 每次激活/签署生成密码学随机防重 token，作为记录唯一标识，杜绝伪造重放。 |

**典型场景**：用户协议签署、授权书确认、操作留痕——需要「对方确实同意过」的可信证据，又不想因脱敏让签署信息不可读。

### 3. 组合编排

- **独立可用**：只需要设备上限、或只需要哈希存证，都可单独引入对应模块。
- **组合成底座**：版权校验（先验授权）+ 电子签（签完存证）串成完整闭环——`激活成功 → 生成授权存证`，二者同事务写入，保证「有激活必有签署」。
- **与业务解耦**：不依赖宿主系统的订单、用户、权限模型，纯通用逻辑，可嵌入小程序 / Web / 服务端任何场景。

### 4. 安全与隐私边界

- **零敏感信息**：骨架库本身不携带任何真实用户数据、凭据或协议条款，只有通用逻辑，可放心开源。
- **存储原文但对外可控**：存证原文用于取证，对外展示可自主决定是否掩码，脱敏逻辑交由配套的 [`qinglvsenlin-desens`](https://github.com/XXX95-del/qinglvsenlin-desens) 负责。
- **天然可审计**：签署记录含 IP、时间、协议版本、内容哈希，构成可回溯的完整证据链。

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

## 关于

qinglvsenlin-copyright 是「青律森林」版权保护体系的**开源骨架**——聚焦**版权校验（设备激活上限）**与**电子签（哈希存证）**两块通用机制。它去除了宿主系统的全部业务耦合与敏感信息：不绑定数据库、不携带真实数据、不含商户/客户资料，可自由嵌入任何应用，也可独立演进。

与同样开源的 [`qinglvsenlin-desens`（脱敏系统）](https://github.com/XXX95-del/qinglvsenlin-desens) 互为配套——脱敏负责"敏感信息不落地"，版权合规负责"授权与存证可信"。二者独立发布、可组合使用，共同构成一套从数据安全到权属证明的完整合规底座。

## 关于作者

我是赵小侗律师，也是「青律森林」网站的独立开发者。这个版权合规开源骨架源自我在处理软件权属与电子存证时遇到的实际需求——既要保护开发者的作品不被越权使用，又要让授权行为本身可被可信验证。如果你对版权校验、电子签或法律科技有想法，欢迎通过 Issue 或讨论区交流。