import { DeviceQuotaGuard, sequentialDemo } from '../src/devices';
import { sha256Hex, consentDigest, signatureDigest, randomToken } from '../src/esign';

/**
 * 版权校验 + 电子签骨架 —— 端到端演示（纯内存，无任何真实数据/密钥）。
 *
 * 运行：pnpm tsx examples/demo.ts  或  npx ts-node examples/demo.ts
 */
const truncated = (s: string) => s.slice(0, 24) + '…';

async function main() {
  console.log('== 版权校验骨架：设备激活上限（原子并发控制）==');

  // 内存模拟存储层
  const active = new Map<string, string>(); // deviceId -> token
  const guard = new DeviceQuotaGuard(3); // 上限 3 台

  const activate = async (device: string) => {
    const ok = await guard.activate(
      async () => {},                       // 行锁串行闸门（生产见 devices.ts 注释）
      async () => active.size,              // 临界区内读当前活跃数
      async () => active.set(device, randomToken('ACT', 6)), // 临界区内写
    );
    if (ok) {
      const t = active.get(device)!;
      console.log(`  ${device} -> ACTIVATED  token=${truncated(t)}`);
    } else {
      console.log(`  ${device} -> DEVICE_LIMIT（已达上限 3 台）`);
    }
  };

  await activate('device-A');
  await activate('device-B');
  await activate('device-C');
  await activate('device-D'); // 第 4 台应被拒
  console.log(`  → 活跃激活数=${active.size}（严格 ≤ 3）`);

  // 幂等：同设备再次激活复用原 token
  const again = await guard.activate(
    async () => {},
    async () => active.size,
    async () => {}, // 幂等时不新增
  );
  console.log(`  → device-A 再次激活放行=${again}`);

  console.log('\n== 电子签骨架：协议版本哈希存证 ==');

  const content = '软件知识产权许可协议（骨架演示模板，不含真实条款）';
  const contentHash = await sha256Hex(content);
  const signedAt = new Date().toISOString();

  // 勾选同意（无手写签名）
  const consent = consentDigest({ contentHash, consent: true, signedAt, signerName: '示例用户' });
  // 手写签名
  const signature = Buffer.from('DEMO_SIGNATURE_BYTES');
  const sig = signatureDigest({ contentHash, signedAt, signature });

  console.log('  协议正文 SHA-256 :', truncated(contentHash));
  console.log('  同意存证摘要     :', truncated(consent));
  console.log('  签名存证摘要     :', truncated(sig));
  console.log('  （协议正文与签名图存原文；哈希仅用于防篡改绑定）');

  console.log('\n== sequentialDemo（内置顺序判定演示，上限 2 / 尝试 5）==');
  const seq = await sequentialDemo(2, 5);
  console.log(`  → granted=${seq.granted}, rejected=${seq.rejected}（严格 ≤2）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});