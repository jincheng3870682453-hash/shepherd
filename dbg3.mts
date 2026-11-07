import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from './src/adapters/store.ts';
import { ReplayModel } from './src/adapters/llm.ts';
import { SessionRunner } from './src/apps/runner.ts';
const dir = mkdtempSync(join(tmpdir(), 'dbg3-'));
const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
const records = [
  { sessionId: 'r', turnIndex: 0, toolStarts: [{ tool: 'cmd', args: {}, optimistic: false }] },
  { sessionId: 'r', turnIndex: 1, text: 'done' },
];
let resolveFn: (v: unknown) => void = () => {};
const executor = async () => new Promise(res => { resolveFn = res; });
const runner = new SessionRunner(bus, new ReplayModel(records), {
  sessionId: 'r', model: 'mock', optimisticWhitelist: [], executor,
});
await runner.start('evt_x');
const handle = [...runner.session.handles.keys()][0];
runner.cancelHandle(handle, 'watchdog');
resolveFn({ late: true });
await new Promise(r => setTimeout(r, 10));
console.log('pending before drive:', runner.session.pending.map(p => `${p.kind}@${p.seq}`));
await runner.drive();
console.log('state:', runner.session.handles.get(handle).state);
console.log('events:', bus.allEvents().map(e => `${e.type}@${e.seq} ${JSON.stringify(e.payload)}`).join('\n'));
bus.close();
