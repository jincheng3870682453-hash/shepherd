/**
 * 真实 GitHub 端到端第三幕（P3-d）：真 PR 工作流 —— API-only 版。
 *
 * 裂缝 C-2：本机网络分流（api.github.com 直连可达，github.com 主站被墙 + 全局
 * git 代理已死 + credential helper 路径损坏）。git-over-HTTPS 不可用时，
 * 改用 GitHub Contents/Git/PR API 完成同一工作流（这也是跨机部署时 Worker
 * 无本地 git 的形态——协议上完全等价）。
 *
 * 流程：建 issue（真触发）→ 受理 → HooH 沙箱改工作副本（mandate 写权限）
 * → Contents API 读原文 + PUT 写新分支 → PR API 开真 PR → 评论回写 → 收单。
 * 运行：node --experimental-strip-types scripts/gh-act3.mts
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { HoohMcpClient } from '../src/adapters/hooh.ts';
import { SqliteBus } from '../src/adapters/store.ts';
import { Orchestrator, type Assessor } from '../src/core/orchestrator.ts';
import { SessionRunner } from '../src/apps/runner.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';

const REPO = 'jincheng3870682453-hash/shepherd-playground';
const API = `https://api.github.com/repos/${REPO}`;
const token = process.env['GITHUB_TOKEN'] ?? '';
assert.ok(token !== '', 'GITHUB_TOKEN 必须设置');
const GH = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'shepherd-act3', ...(init?.headers ?? {}) },
  });
const bus = new SqliteBus(join(mkdtempSync(join(tmpdir(), 'gh-act3-')), 'ev.db'), 'k');

// 1. 建 issue（真触发）
const issueRes = await GH('/issues', { method: 'POST', body: JSON.stringify({ title: 'SHEPHERD_TASK: add project banner via API PR', body: 'Add a banner line at the TOP of README.md. Open a PR.' }) });
assert.ok(issueRes.ok, `建 issue 失败: ${issueRes.status}`);
const issue = (await issueRes.json()) as { number: number };
console.log(`[act3] issue #${issue.number} created`);

// 2. 受理（结构化源旁路）
const assessor: Assessor = input => (input.kind === 'issue' && input.text.includes('SHEPHERD_TASK') ? { accept: true, mandate: input.text.slice(0, 120) } : { accept: false, reason: 'not_a_task' });
const orch = new Orchestrator(bus, { assessor });
const trig = bus.append(bus.root('source.trigger.received', `github:${REPO}`, { naturalKey: `gh:${REPO}:issue:act3-${issue.number}`, thread: `gh:${REPO}#${issue.number}`, kind: 'issue', text: 'SHEPHERD_TASK banner' }, `gh_trg_act3_${issue.number}`), `act3-${issue.number}`);
assert.ok(trig.kind === 'stored');
const ticketId = orch.onTrigger(trig.event.seq, trig.event.id, `gh:${REPO}#${issue.number}`, 'issue', 'SHEPHERD_TASK banner', true);
assert.ok(ticketId !== null);
console.log(`[act3] ticket ${ticketId} opened`);

// 3. 取 main 分支基线（Contents API + branch ref）
const refRes = await GH('/git/ref/heads/main');
assert.ok(refRes.ok);
const mainSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;
const readmeRes = await GH('/contents/README.md?ref=main');
assert.ok(readmeRes.ok);
const readme = (await readmeRes.json()) as { content: string; sha: string };
const origContent = Buffer.from(readme.content, 'base64').toString('utf-8');
console.log(`[act3] main@${mainSha.slice(0, 7)}, README ${origContent.length} bytes`);

// 4. Worker：HooH 沙箱内改本地工作副本（mandate 写权限），产出目标内容
const workdir = mkdtempSync(join(tmpdir(), 'act3-work-'));
const workFile = join(workdir, 'README.md');
await writeFile(workFile, origContent, 'utf-8');
const hooh = new HoohMcpClient(bus, {
  pythonPath: 'C:/Users/69215/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  serverScript: process.env['ACE_HOME'] ?? 'G:/_归档/AI_Project/ace/ai_code.py',
  projectRoot: workdir,
  permission: 'write',
  callTimeoutMs: 30_000,
});
await hooh.start();
const records: TurnRecord[] = [
  { sessionId: `worker-${ticketId}`, turnIndex: 0, toolStarts: [{ tool: 'str_replace', args: { path: 'README.md' }, optimistic: false }] },
  { sessionId: `worker-${ticketId}`, turnIndex: 1, text: 'TASK_DONE: banner added via HooH str_replace' },
];
const firstLine = origContent.split('\n')[0] ?? '';
const executor = async (tool: string, args: Record<string, unknown>, handle: string): Promise<unknown> => {
  const r = await hooh.callTool(tool, args, `ts_${handle}`);
  if (r.decision !== 'allow') throw new Error(`HooH ${r.decision}: ${r.text.slice(0, 120)}`);
  return { text: r.text };
};
const worker = new SessionRunner(bus, new ReplayModel(records), {
  sessionId: `worker-${ticketId}`, model: 'mock', optimisticWhitelist: [], executor,
});
await worker.start(trig.event.id);
const edit = await hooh.callTool('str_replace', { path: 'README.md', old_string: firstLine, new_string: `# Shepherd Playground (managed by Shepherd)\n${firstLine}` }, `ts_edit_${ticketId}`);
console.log(`[act3] str_replace: ${edit.decision}`);
assert.equal(edit.decision, 'allow', 'mandate 应放行 str_replace');
const edited = await writeFile(workFile, await import('node:fs/promises').then(m => m.readFile(workFile, 'utf-8')), 'utf-8').then(() => undefined);
await worker.drive();

// 5. 读沙箱产物 → 建 blob/Tree/Commit → 新分支 → PR（GitHub Git API，git 客户端不参与）
const fsp = await import('node:fs/promises');
const newContent: string = await fsp.readFile(workFile, 'utf-8');
const blobRes = await GH('/git/blobs', { method: 'POST', body: JSON.stringify({ content: Buffer.from(newContent, 'utf-8').toString('base64'), encoding: 'base64' }) });
assert.ok(blobRes.ok, `blob 失败: ${blobRes.status}`);
const blobSha = ((await blobRes.json()) as { sha: string }).sha;
const treeRes = await GH('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: mainSha, tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blobSha }] }) });
assert.ok(treeRes.ok, `tree 失败: ${treeRes.status}`);
const treeJson = (await treeRes.json()) as { sha: string };
const commitRes = await GH('/git/commits', { method: 'POST', body: JSON.stringify({ message: `feat: add project banner (via ${ticketId})`, tree: treeJson.sha, parents: [mainSha] }) });
assert.ok(commitRes.ok, `commit 失败: ${commitRes.status}`);
const commitSha = ((await commitRes.json()) as { sha: string }).sha;
const branchRes = await GH('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/shepherd/${ticketId}`, sha: commitSha }) });
assert.ok(branchRes.ok, `分支失败: ${branchRes.status}`);
const prRes = await GH('/pulls', { method: 'POST', body: JSON.stringify({ title: `[${ticketId}] add project banner`, head: `shepherd/${ticketId}`, base: 'main', body: `Delivered by Shepherd ticket \`${ticketId}\`.\n\n- Tool path: HooH sandbox (mandate-backed \`str_replace\`)\n- Delivery via Git API (no local git) — cross-machine equivalent\n- All adjudications on the event bus (HMAC chain)` }) });
assert.ok(prRes.ok, `开 PR 失败: ${prRes.status}`);
const pr = (await prRes.json()) as { number: number; html_url: string };
console.log(`[act3] PR #${pr.number}: ${pr.html_url}`);

// 6. 评论回写 + 收单
const cRes = await GH(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `**${ticketId}** delivered as PR #${pr.number}` }) });
assert.ok(cRes.ok);
orch.workerDone(ticketId!, 'delivered', `PR #${pr.number}`, `tkt_${ticketId}`);
assert.equal(orch.view.byId.get(ticketId!)!.status, 'done');
assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
console.log(`[act3] chain OK; total events: ${bus.allEvents().length}`);
await hooh.stop();
bus.close();
console.log('REAL PR WORKFLOW (API-only) OK');
