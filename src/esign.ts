/**
 * 电子签 —— 哈希存证（骨架）
 *
 * 目标：为「用户同意某版本协议」建立不可抵赖的证据，且协议正文防篡改。
 * 做法：对「协议正文哈希 + 同意/签名凭据 + 签署时间」做 SHA-256 绑定存证。
 * 协议正文本身存原文；存证哈希只需小额、无需改写原文。
 *
 * 纯 Node crypto 实现，不依赖任何框架 / 数据库 / SDK。
 */

import { createHash, randomBytes } from 'node:crypto';

/** 对一段字节做 SHA-256，返回十六进制小写。 */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 基于同意的签署存证。
 * 当用户仅"勾选同意"（无手写签名）时，以 consent 标记作为同意凭据。
 */
export function consentDigest(opts: {
  contentHash: string; // 所同意协议正文的 SHA-256
  consent: boolean;    // 是否勾选同意（主凭据）
  signedAt: string;    // 签署时间（ISO 字符串）
  signerName?: string; // 署名（可选）
}): string {
  const parts = [
    'consent', String(opts.consent),
    `content:${opts.contentHash}`,
    `at:${opts.signedAt}`,
  ];
  if (opts.signerName) parts.push(`signer:${opts.signerName}`);
  return sha256Hex(parts.join('::'));
}

/**
 * 基于手写签名的签署存证。
 * @param signatureData 手写签名的原始字节（PNG 等），签名图本身不入哈希，仅参与凭据。
 */
export function signatureDigest(opts: {
  contentHash: string;
  signedAt: string;
  signature: Buffer;     // 手写签名原始字节
  signerId?: string;     // 签署主体标识（可选，编号类）
  extra?: string;        // 附加上下文（可选，如设备限定）
}): string {
  const parts = [
    `content:${opts.contentHash}`,
    `at:${opts.signedAt}`,
    `sig:${sha256Hex(opts.signature)}`, // 签名图的 SHA-256
  ];
  if (opts.signerId) parts.push(`signer:${opts.signerId}`);
  if (opts.extra) parts.push(`extra:${opts.extra}`);
  return sha256Hex(parts.join('::'));
}

/**
 * 生成不透明 token（类似于激活/会话令牌），crypto 强随机，不可推断。
 */
export function randomToken(prefix: string, bytes = 16): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}

/** 演示：同一协议正文 + 同意标记，得到稳定的存证哈希。 */
export function demo() {
  const LOREM = '这是一段示例协议正文（骨架用，不含真实条款）。';
  const contentHash = sha256Hex(LOREM);
  const signedAt = new Date().toISOString();
  const digest = consentDigest({ contentHash, consent: true, signedAt });
  return { contentHash, signedAt, digest, token: randomToken('DL') };
}