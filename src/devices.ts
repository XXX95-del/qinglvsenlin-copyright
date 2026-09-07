/**
 * 设备激活上限 —— 原子并发控制（骨架）
 *
 * 背景：离线文件的版权保护让单一授权在 N 台设备上激活。判断「当前活跃数 < N」
 * 必须并发安全，否则脚本可并发打满 N 次绕过上限。
 *
 * 本模块提供「锁内重查计数」的原子判定范式，并给出可落地的数据库实现说明。
 * 不依赖任何特定数据库/框架，生产接入方式在注释中以 Postgres 为例展示。
 */

/**
 * 原子激活守卫。
 *
 * 核心不变量：读 count 与写激活记录必须落在同一临界区（同一次串行化区间），
 * 否则并发下多个请求读到同一个旧 count 一起放行，从而突破上限。
 *
 * @param maxDevices 单文件授权设备上限 N
 */
export class DeviceQuotaGuard {
  constructor(private readonly maxDevices: number) {}

  /**
   * @param drainForFile 串行闸门：确保同一 fileId 的提交按序进入临界区。
   *                     生产实现（Postgres 示例，事务内）：
   *                       INSERT INTO activation_configs(file_id, max_devices)
   *                         VALUES ($fileId, DEFAULT) ON CONFLICT (file_id) DO NOTHING;
   *                       SELECT max_devices FROM activation_configs
   *                         WHERE file_id = $fileId FOR UPDATE;  -- 行锁锚点
   *                     注意：咨询锁(pg_advisory_xact_lock)在连接池场景可能失效，
   *                           行锁(SELECT ... FOR UPDATE)最稳。
   * @param readActive   读当前活跃激活数。生产：临界区内 SELECT count(*) FROM activations
   *                     WHERE file_id=$fileId AND is_active=true;（因串行必为最新值）
   * @param insert       写入激活记录。生产：临界区内 INSERT。
   * @returns true=放行 / false=已达上限
   */
  activate(
    drainForFile: () => Promise<void>,
    readActive: () => Promise<number>,
    insert: () => Promise<void>,
  ): Promise<boolean> {
    return (async () => {
      await drainForFile(); // 串行闸门：同 file 并发时逐个进入
      const count = await readActive(); // 临界区内读取，值必然最新
      if (count >= this.maxDevices) return false;
      await insert();
      return true;
    })();
  }
}

/**
 * 顺序判定的演示：串行（无并发扰动）下 N 台上限严格生效。
 */
export async function sequentialDemo(max: number, attempts: number) {
  const guard = new DeviceQuotaGuard(max);
  let granted = 0;
  for (let i = 0; i < attempts; i++) {
    const ok = await guard.activate(
      async () => {},
      async () => granted, // 临界区读当前已授予数
      async () => { granted++; },
    );
    if (!ok) return { granted, rejected: attempts - i };
  }
  return { granted, rejected: 0 };
}