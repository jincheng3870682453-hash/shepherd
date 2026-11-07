/**
 * 真实 HooH 回滚演示（P3-d 收尾）—— 经由 HooH 的快照机制做"破坏→恢复"闭环。
 *
 * HooH MCP 暴露面不含 rollback/undo 工具（core/ace_mcp_server.py 白名单核实：
 * 快照是写路径的自动伴生行为，回滚是交互式 REPL 的 /undo 命令，不是工具）。
 * 因此 Shepherd 的恢复协议 = 保留破坏前内容（Worker 侧职责）+ HooH 快照审计
 * （.ace_sessions 台账）双通道。本演示：
 *   1. 原始内容先经 file_read 留痕于总线（内容哈希）；
 *   2. 破坏性写入（HooH 自动快照，台账 MAC 链可核）；
 *   3. 恢复 = file_write 写回原始内容（经 HooH 裁决，同样进台账）；
 *   4. 断言：恢复后内容与破坏前逐字节一致；总线全程留痕。
 * 运行：node --experimental-strip-types scripts/hooh-rollback-demo.mts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoohMcpClient } from '../src/adapters/hooh.ts';
import { SqliteBus } from '../src/adapters/store.ts';

const workdir = mkdtempSync(join(tmpdir(), 'rollback-demo-'));
const target = join(workdir, 'precious.txt');
const ORIGINAL = 'ORIGINAL CONTENT - do not lose\nline two\n';
writeFileSync(target, ORIGINAL, 'utf-8');
const originalHash = createHash('sha256').update(ORIGINAL).digest('hex').slice(0, 16);

const bus = new SqliteBus(join(workdir, 'ev.db'), 'k');
const client = new HoohMcpClient(bus, {
  pythonPath: process.env['DSH_PY'] ?? 'C:/Users/69215/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  serverScript: process.env['ACE_HOME'] ?? 'G:/_归档/AI_Project/ace/ai_code.py',
  projectRoot: workdir,
  permission: 'write',
  callTimeoutMs: 30_000,
});
client.onStderr(() => {});
await client.start();
console.log(`[rollback] HooH up; original hash=${originalHash}`);

// 1. 原始内容留痕（总线）
await client.callTool('file_read', { path: 'precious.txt' }, 'evt_read_orig');

// 2. 破坏性写入（HooH 自动快照，台账 MAC 链）
const w = await client.callTool('file_write', { path: 'precious.txt', content: 'CLOBBERED!!! original is gone\n' }, 'evt_w');
assert.equal(w.decision, 'allow');
const clobbered = readFileSync(target, 'utf-8');
assert.ok(clobbered.includes('CLOBBERED'));
console.log('[rollback] clobbered OK');

// 3. 恢复（写回原始内容——HooH 裁决 + 快照伴生 + 台账）
const restore = await client.callTool('file_write', { path: 'precious.txt', content: ORIGINAL }, 'evt_restore');
assert.equal(restore.decision, 'allow');
const restored = readFileSync(target, 'utf-8');
// 行尾归一化后比对（裂缝 C-3：HooH/Python 文本模式在 Windows 写 \r\n，node 写 \n——
// 语义等价、字节不同。对拍与恢复断言一律归一化行尾）
const norm = (s: string): string => s.replace(/\r\n/g, '\n');
const restoredHash = createHash('sha256').update(norm(restored)).digest('hex').slice(0, 16);
assert.equal(restoredHash, originalHash, '恢复后应与原始内容语义一致（行尾归一化）');
console.log(`[rollback] restored hash=${restoredHash} — 归一化后逐字节一致`);

// 4. 总线核对：全程留痕（read/write/write 三次裁决 + denyStreak 归零）
const decided = bus.allEvents().filter(e => e.type === 'hooh.decided');
console.log(`[rollback] hooh.decided: ${decided.map(e => (e.payload as { decision: string }).decision).join(',')}`);
assert.equal(decided.length, 3);
assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
console.log(`[rollback] chain OK; total events: ${bus.allEvents().length}`);
await client.stop();
bus.close();
rmSync(workdir, { recursive: true, force: true });
console.log('ROLLBACK-STYLE RECOVERY DEMO OK');
