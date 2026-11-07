/**
 * 真 HooH-MCP 冒烟脚本（P3-c；docs/007 P3 验收的一部分）。
 * 前置：本机有 ace 仓库（serverScript 指向 ai_code.py）与 DSH 捆绑 Python。
 * 运行：node --experimental-strip-types scripts/hooh-smoke.mts
 * 预期：file_read → allow；file_write → asked（readonly 档 fail-close）；两条 hooh.decided 入总线。
 */
import assert from 'node:assert/strict';
import { HoohMcpClient } from '../src/adapters/hooh.ts';
import { SqliteBus } from '../src/adapters/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hooh-smoke-'));
const bus = new SqliteBus(join(dir, 'ev.db'), 'smoke-key');
const py = process.env['DSH_PY'] ?? 'C:/Users/69215/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
const serverScript = process.env['ACE_HOME'] ?? 'G:/_归档/AI_Project/ace/ai_code.py';
const client = new HoohMcpClient(bus, {
  pythonPath: py,
  serverScript,
  projectRoot: 'G:/superagnet/shepherd',
  permission: 'readonly',
  callTimeoutMs: 30_000,
});
client.onStderr(() => {});
await client.start();
console.log('[smoke] HooH MCP 启动成功');

const r1 = await client.callTool('file_read', { path: 'README.md' }, 'evt_smoke_1');
console.log(`[smoke] file_read → ${r1.decision} (denyStreak=${client.currentDenyStreak()})`);
assert.equal(r1.decision, 'allow');

const r2 = await client.callTool('file_write', { path: 'smoke-test.txt', content: 'x' }, 'evt_smoke_2');
console.log(`[smoke] file_write → ${r2.decision} (denyStreak=${client.currentDenyStreak()})`);
assert.ok(r2.decision === 'asked' || r2.decision === 'deny');

const decided = bus.allEvents().filter(e => e.type === 'hooh.decided');
console.log(`[smoke] hooh.decided: ${decided.map(e => (e.payload as { decision: string }).decision).join(',')}`);
assert.equal(decided.length, 2);

await client.stop();
bus.close();
console.log('[smoke] ALL PASS');
