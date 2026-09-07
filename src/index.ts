/**
 * legal-compliance-skeleton
 *
 * 版权校验 + 电子签 的通用骨架（纯 TypeScript，零第三方运行时依赖）。
 *
 * 本库与「脱敏系统」相互独立 → 详见独立的 desensitization-system 开源模块。
 * 聚焦两块可独立复用的版权合规原子能力：
 *   1) devices.ts  版权校验 / 设备激活上限（并发安全的原子配额）
 *   2) esign.ts    电子签 / 协议哈希存证（SHA-256 防篡改绑定）
 *
 * 仅含机制骨架，不含任何真实用户信息、密钥、或业务协议条款。
 */

export * from './devices';
export * from './esign';