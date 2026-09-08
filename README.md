# 版权合规方案

> **⚠️ 免责声明（请先阅读）**
>
> 本仓库是一个**商业授权执行的通用技术范式样例（sample）**，并非一款免费的离线工具，也不构成法律意见。
>
> - 仅提供「设备激活上限 + 协议哈希存证」两块**可复用方法论**，**不含**任何完整可部署的授权服务端实现、密钥或真实协议条款。
> - 实际接入时，对签名图、设备 ID 等信息的采集、存储与处理，是否符合你所在司法辖区的适用法规（如中国《个人信息保护法》），**由接入方自行评估**。
> - 文中「离线」仅指「本地 HTML 通过 iframe 发起的交互形态」；**版权校验本身仍需回连服务端完成**。

面向「离线内容 / 软件版权保护」的通用实现方案，解决一个核心命题：

> **让「授权」这件事既技术可管，又留痕可信。**

纯 TypeScript 实现，**零第三方运行时依赖**，可嵌入任意后端（Node / Postgres / Redis / KV）。

## 方案重点

### 1. 「签署即激活」的原子流程

大多数方案里，「签署协议」和「激活软件」是**两件独立的事**。本方案的核心设计是——**想拿到激活权就必须先签署**，签署与激活在同一原子请求里完成：

- 签署记录与激活记录**同时落库**；
- 无法只绕过版权而跳过签署；
- 这是本方案区别于其他方案的核心差异。

### 2. 版本化条款与可追溯证据链

市面上大多数方案只记录「用户已签署」，**不记录签的是哪个版本**。本方案通过 `agreement_versions` 实现**条款版本化**：

- 旧版永不覆盖，历史签署永远能对回到当时签署的条款；
- 签署记录保存 `content_hash`，纠纷时可与服务端现行版本比对；
- 该思想与软件激活流程深度绑定。

### 3. 本地 HTML 亦能发起签署（非免授权）

本方案通过 `form + iframe + postMessage` 实现**本地 HTML 文件的跨域通信**：

- 用户可在「仅访问本地文件、无在线服务页面」的情况下发起签署与激活请求；
- 请注意：**这只解决交互形态，版权校验的放行仍依赖服务端**——断网或授权服务不可用时，激活不会成功。本方案不是「断网免授权」工具。

### 4. 签署留痕与授权控制的结合

商业方案强调身份验证与全证据链；技术方案侧重授权控制。本方案**两者兼具**：

- 既有**技术层面**的授权控制（设备激活上限、并发封顶、幂等复用）；
- 又有**留痕层面**的签署存证（哈希存证、条款版本化、证据链可回溯）；
- 且两者在**同一个事务**中完成。

> 说明：本方案提供的是「不可抵赖的留痕手段」（正文/签名哈希存证 + 原文证据），**并非符合法律意义的电子签名服务**。若需等同手写签名/司法认可的电子签名效力，请另行接入具备《电子签名法》或其他此种类型法律规定的具有资质的可靠电子签名服务。

## 架构

```
┌────────────────────────────────────────────┐
│                业务层（宿主系统）             │
│   文件元数据 / 用户 / 订单 / 权限           │
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

const r = await guard.activate(
  async () => { await lockFile('doc-1'); },      // 串行化同一文件的并发激活
  async () => countActive('doc-1'),               // 锁内重查
  async (dev) => insertActivation('doc-1', dev),  // 未满才写入
);

if (r.code === 'ACTIVATED')      { /* 新设备激活成功 */ }
if (r.code === 'DEVICE_ALREADY') { /* 同设备幂等复用 token */ }
if (r.code === 'DEVICE_LIMIT')   { /* 已达上限，拒绝 */ }
```

设计要点：

- **锁外乐观放行的误区**：若只在锁外先查计数再插入，并发请求会同时读到旧值 → 一起通过 → 突破上限。
- **正确范式**：为同一授权对象加**排他锁**（行锁 / `SELECT ... FOR UPDATE` / Redis 分布式锁 / advisory lock），在锁内**重新读取**当前活跃数，未满才插入，并依赖「文件↔设备」唯一索引兜底。
- **幂等**：同一设备重复激活，复用已签发 token，不新增记录。
- 通过回调注入持久化，天然适配多种存储。

### `esign.ts` — 协议哈希存证（不可抵赖）

「签署不可抵赖」不靠封存明文干扰阅读，而靠**哈希绑定** + **原文证据**：

- **可读证据**：协议正文、签署者姓名、签名图像等作为可读签署证据保留，供司法作证。
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

- **哈希链**：同意 → 正文 → 签名图逐层绑定，任一环节被改都可检测。
- **版本化**：正文先算 `content_hash` 并绑定协议版本，协议升级即暴露，历史签署仍可对回原条款。
- **与设备上限解耦**：即使设备数达标，签署存证逻辑独立可复用。

## 快速开始

本方案零运行时依赖，直接安装类型即可运行示例：

```bash
pnpm install
pnpm tsx examples/demo.ts   # 运行设备上限 + 电子签演示
```

示例输出：严格限制 3 台设备（第 4 台被拒）、同设备幂等复用、正文/签名哈希存证可核验。

## 本地构建

```bash
pnpm install               # 安装 typescript / tsx / @types/node（仅开发期）
pnpm run build             # tsc 编译 → dist/（供产物发布）
npx tsx examples/demo.ts   # 直接运行示例
```

构建产物为干净 ESM，可在宿主工程中以源码或打包后引用。

## 部署方案

本方案**零第三方运行时依赖**，以「调用方注入读写回调」的方式接入任何后端。下面按存储选型给出标准部署范式。

### 方式 A：PostgreSQL（推荐，兼并发安全最稳）

设备上限与签署记录落在同一事务，用 **行锁**串行化同一文件的激活（比咨询锁更可靠）。

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

-- 3) 签署存证表（可读证据 + 哈希绑定）——与电子签搭配
CREATE TABLE signing_records (
  file_id        text NOT NULL,
  device_id      text NOT NULL,
  agreement_id   uuid,          -- 关联协议版本
  signer_name    text,          -- 可读签名者
  signature_image text,          -- 签名图原样(base64)
  signature_hash  text NOT NULL, -- SHA-256 存根
  ip             text,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, device_id)
);
```

服务端激活事务（示意，事务内串行）：

```ts
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
- **签署与激活同事务**：激活成功必留签署，失败整体回滚（无漏档）。

> 注意：上述 SQL 仅为接入范式示意，非开箱即用的全网部署包。真实授权服务端（含激活校验、设备上限判定、token 签发）建议按需独立闭环部署，并遵守适用的数据保护法规。

### 方式 B：Redis / 单机内存（轻量场景）

用 Redis 分布式锁（`SETNX`/`Redlock`）或单节点内存互斥，锁内 `readActive→compare→insert`：

```ts
import { createClient } from 'redis';

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

## 许可

[Apache License 2.0](./LICENSE)

## 关于

`qinglvsenlin-copyright` 是「青律森林」版权保护体系的**开源组件**——聚焦**版权校验（设备激活上限）**与**电子签（哈希存证）**两块通用机制。它去除了宿主系统的全部业务耦合，不绑定数据库，可自由嵌入任何应用，也可独立演进。

与同样开源的 [`qinglvsenlin-desens`（脱敏系统）](https://github.com/XXX95-del/qinglvsenlin-desens) 互为配套，独立发布、可组合，共同构成一套从数据安全到权属证明的完整合规底座。

## 关于作者

我是赵小侗律师，也是「青律森林」网站的独立开发者。这个版权合规开源组件源自我在处理软件权属与电子存证时遇到的实际需求——既要保护开发者的作品不被越权使用，又要让授权行为本身可被可信验证。如果你对版权校验、电子签或法律科技有想法，欢迎通过 Issue 或讨论区交流。