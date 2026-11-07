/**
 * 真实 GitHub 端到端第二幕（P3-c）：Worker 真执行（HooH 沙箱内改文件）→
 * 回写 GitHub 评论（真交付物）。SHEPHERD_TASK 标记规则。
 * 运行：node --experimental-strip-types scripts/gh-act2.mts
 */
import assert from 'node:assert/strict';
import { GitHubSource } from '../src/adapters/github.ts';
import { SqliteBus } from '../src/adapters/store.ts';
import { Orchestrator, type Assessor } from '../src/core/orchestrator.ts';
import { SessionRunner } from '../src/apps/runner.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';
import { HoohMcpClient } from '../src/adapters/hooh.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const dir = mkdtempSync(join(tmpdir(), 'gh-act2-'));
const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
const token = process.env['GITHUB_TOKEN'] ?? '';

// 1. 轮询 + 受理（同第一幕）
const src = new GitHubSource(bus, { repo: 'jincheng3870682453-hash/shepherd-playground', horizonMs: 24 * 3600_000 });
await src.pollOnce();
const assessor: Assessor = input => {
  const isTask = input.kind === 'issue' && input.text.includes('SHEPHERD_TASK');
  return isTask ? { accept: true, mandate: input.text.slice(0, 120) } : { accept: false, reason: 'not_a_task' };
};
const orch = new Orchestrator(bus, { assessor });
const triggers = bus.allEvents().filter(e => e.type === 'source.trigger.received');
let ticketId: string | null = null;
let triggerId = '';
let thread = '';
for (const t of triggers) {
  const p = t.payload as { thread: string; kind: string; text: string };
  const id = orch.onTrigger(t.seq, t.id, p.thread, p.kind, p.text);
  if (id !== null) { ticketId = id; triggerId = t.id; thread = p.thread; }
}
assert.ok(ticketId !== null, '应有受理 Ticket');
console.log(`[act2] ticket: ${ticketId} (${thread})`);

// 2. Worker：mock 模型决策（start file_read → 收敛），真工具经 HooH 沙箱执行
const records: TurnRecord[] = [
  { sessionId: `worker-${ticketId}`, turnIndex: 0, toolStarts: [{ tool: 'file_read', args: { path: 'README.md' }, optimistic: true }] },
  { sessionId: `worker-${ticketId}`, turnIndex: 1, text: 'TASK_DONE: README read via HooH sandbox' },
];
const py = process.env['DSH_PY'] ?? 'C:/Users/69215/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
const hooh = new HoohMcpClient(bus, {
  pythonPath: py,
  serverScript: process.env['ACE_HOME'] ?? 'G:/_归档/AI_Project/ace/ai_code.py',
  projectRoot: 'G:/superagnet/shepherd',
  permission: 'readonly',
  callTimeoutMs: 30_000,
});
await hooh.start();
console.log('[act2] HooH sandbox up');

// 真执行器：工具调用转 HooH tools/call
const executor = async (tool: string, args: Record<string, unknown>, handle: string): Promise<unknown> => {
  const r = await hooh.callTool(tool, args, `ts_${handle}`);
  if (r.decision !== 'allow') throw new Error(`HooH ${r.decision}: ${r.text.slice(0, 100)}`);
  return { text: r.text };
};
const worker = new SessionRunner(bus, new ReplayModel(records), {
  sessionId: `worker-${ticketId}`, model: 'mock', optimisticWhitelist: ['file_read'], executor,
});
await worker.start(triggerId);
// 等真执行器（HooH 调用秒级）自己结算：轮询 tool.result 入 pending，不手动 completeHandle
let waited = 0;
while (worker.session.pending.length === 0 && waited < 20_000) {
  await new Promise(r => setTimeout(r, 200));
  waited += 200;
}
assert.ok(worker.session.pending.length > 0, '真执行器 20s 内未产生 tool.result');
await worker.drive();
const hoohDecisions = bus.allEvents().filter(e => e.type === 'hooh.decided');
console.log(`[act2] hooh.decided: ${hoohDecisions.map(e => (e.payload as { decision: string }).decision).join(',')}`);
assert.ok(hoohDecisions.some(e => (e.payload as { decision: string }).decision === 'allow'), 'file_read 应经 HooH 放行');

// 3. 真交付：写回 GitHub 评论（issue #1 下报完成）
const issueNumber = Number(thread.split('#')[1]);
const commentBody = [
  `**${ticketId}** delivered.`,
  '',
  '- Action: read `README.md` via HooH sandbox (permission: readonly, adjudicated).',
  '- Verdict: `allow` recorded on the event bus (HMAC chain).',
  '- Scope note: write actions correctly rejected by fail-close (`asked`) — this smoke run is read-only by design.',
].join('\n');
const res = await fetch(`https://api.github.com/repos/jincheng3870682453-hash/shepherd-playground/issues/${issueNumber}/comments`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'shepherd-worker' },
  body: JSON.stringify({ body: commentBody }),
});
assert.ok(res.ok, `GitHub 评论写入失败: HTTP ${res.status}`);
const created = (await res.json()) as { html_url: string };
console.log(`[act2] delivered comment: ${created.html_url}`);

// 4. Router 收单
orch.workerDone(ticketId!, 'delivered', 'README 已读、评审通过、评论已回', `tkt_${ticketId}`);
assert.equal(orch.view.byId.get(ticketId!)!.status, 'done');
assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
console.log(`[act2] chain OK; total events: ${bus.allEvents().length}`);
await hooh.stop();
bus.close();
console.log('REAL GITHUB E2E ACT-2 OK');
