// 临时验证脚本：带 mandate 的 HooH 写路径
import { HoohMcpClient } from '../src/adapters/hooh.ts';
import { SqliteBus } from '../src/adapters/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'hooh-w-'));
const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
const client = new HoohMcpClient(bus, {
  pythonPath: 'C:/Users/69215/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  serverScript: 'G:/_归档/AI_Project/ace/ai_code.py',
  projectRoot: 'G:/superagnet/shepherd-playground',
  permission: 'write',
  callTimeoutMs: 30_000,
});
client.onStderr(() => {});
await client.start();
const r = await client.callTool('file_write', { path: 'mandate-test.txt', content: 'written by shepherd via HooH mandate' }, 'evt_w');
console.log('file_write:', r.decision, r.text.slice(0, 100).replace(/\n/g, ' '));
assert.equal(r.decision, 'allow');
const r2 = await client.callTool('file_read', { path: 'mandate-test.txt' }, 'evt_r');
console.log('verify:', r2.decision, r2.text.slice(0, 80).replace(/\n/g, ' '));
assert.ok(r2.text.includes('shepherd'));
await client.stop();
bus.close();
console.log('MANDATE WRITE PATH OK');
