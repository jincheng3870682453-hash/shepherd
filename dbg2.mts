import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from './src/adapters/store.ts';
import { ReplayModel } from './src/adapters/llm.ts';
import { SessionRunner } from './src/apps/runner.ts';
const dir = mkdtempSync(join(tmpdir(), 'dbg2-'));
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
console.log('state after cancel:', runner.session.handles.get(handle).state);
console.log('pending after cancel:', runner.session.pending.length, JSON.stringify(runner.session.pending));
resolveFn({ late: true });
await new Promise(r => setTimeout(r, 10));
console.log('pending after late result:', runner.session.pending.length, JSON.stringify(runner.session.pending.map(p => ({ k: p.kind, h: p.handle }))));
console.log('context:', runner.session.context.length);
console.log('events:', bus.allEvents().map(e => `${e.type}(${JSON.stringify(e.payload).slice(0,40)})`).join(' | '));
bus.close();
