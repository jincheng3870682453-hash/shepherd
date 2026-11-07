/**
 * 真实 GitHub 端到端第一幕（P3-c）：轮询真仓库 → Trigger → Router 受理 → 视图。
 * 关键词用 ASCII（here-string 写盘编码不可靠——裂缝 C-1）。
 * 运行：node --experimental-strip-types scripts/gh-e2e.mts
 */
import assert from 'node:assert/strict';
import { GitHubSource } from '../src/adapters/github.ts';
import { SqliteBus } from '../src/adapters/store.ts';
import { Orchestrator, type Assessor } from '../src/core/orchestrator.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gh-e2e-'));
const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
const src = new GitHubSource(bus, { repo: 'jincheng3870682453-hash/shepherd-playground', horizonMs: 24 * 3600_000 });
console.log('problem:', src.problem);
const n = await src.pollOnce();
console.log('triggers:', n);

// 受理规则：issue 且正文含 SHEPHERD_TASK 标记（ASCII 关键词）
const assessor: Assessor = input => {
  const isTask = input.kind === 'issue' && input.text.includes('SHEPHERD_TASK');
  return isTask ? { accept: true, mandate: input.text.slice(0, 120) } : { accept: false, reason: 'not_a_task' };
};
const orch = new Orchestrator(bus, { assessor });
const triggers = bus.allEvents().filter(e => e.type === 'source.trigger.received');
const opened: string[] = [];
for (const t of triggers) {
  const p = t.payload as { thread: string; kind: string; text: string };
  const id = orch.onTrigger(t.seq, t.id, p.thread, p.kind, p.text);
  if (id !== null) opened.push(`${id}<-${p.thread}`);
}
console.log('opened tickets:', opened);
console.log('filtered:', triggers.length - opened.length);
assert.equal(opened.length, 1, 'issue #1 (带 SHEPHERD_TASK) 应受理，#2 闲聊应过滤');
assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
console.log('chain OK; total events:', bus.allEvents().length);
bus.close();
console.log('REAL GITHUB E2E ACT-1 OK');
