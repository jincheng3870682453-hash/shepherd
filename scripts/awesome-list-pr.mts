/**
 * awesome-deepseek-integration PR（API-only）—— 在 AI Agent frameworks 分类加一行 Shepherd。
 *
 * 网络背景（裂缝 C-2）：本机 github.com 主站间歇不可达，api.github.com 稳定；
 * 因此全程走 GitHub REST API（Contents/Git/PR），不依赖 git-over-HTTPS。
 *
 * 前置：gh 已 fork deepseek-ai/awesome-deepseek-integration 到用户账号。
 * 运行：GH_TOKEN=$(gh auth token) node --experimental-strip-types scripts/awesome-list-pr.mts
 */
const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
if (token === '') {
  console.error('[awesome-pr] 需要 GH_TOKEN');
  process.exit(1);
}
const OWNER = 'jincheng3870682453-hash';
const FORK = 'awesome-deepseek-integration';
const UPSTREAM = 'deepseek-ai';
const BRANCH = 'add-shepherd-entry';
const API = 'https://api.github.com';

const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'shepherd-pr' };
const api = async (path: string, init?: RequestInit): Promise<unknown> => {
  const res = await fetch(`${API}${path}`, { ...init, headers: h });
  const text = await res.text();
  if (!res.ok) throw new Error(`[awesome-pr] ${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text === '' ? {} : JSON.parse(text);
};

// 1. fork main sha + README（fork 的副本）
const ref = (await api(`/repos/${OWNER}/${FORK}/git/ref/heads/main`)) as { object: { sha: string } };
const baseSha = ref.object.sha;
const readme = (await api(`/repos/${OWNER}/${FORK}/contents/README.md?ref=main`)) as { content: string; sha: string; encoding: string };
const original = Buffer.from(readme.content, 'base64').toString('utf-8');

// 2. 插入条目：AI Agent frameworks 表（<span id="agent">）的 </table> 之前
const sectionIdx = original.indexOf('<span id="agent">AI Agent frameworks</span>');
if (sectionIdx < 0) throw new Error('找不到 AI Agent frameworks 分类');
const tableEnd = original.indexOf('</table>', sectionIdx);
if (tableEnd < 0) throw new Error('找不到分类表结尾');

const row = `
    <tr>
        <td><img src="https://raw.githubusercontent.com/${OWNER}/shepherd/main/assets/logo.png" alt="Icon" width="64" height="auto" /></td>
        <td><a href="https://github.com/${OWNER}/shepherd">Shepherd</a></td>
        <td>A micro demo based on DeepSeek's open-sourced Super-agent prototype: implements the four pieces the article lists as future work &mdash; external watchdog (deterministic rules + numeric-only LLM cortex), credit &times; bait verification for worker reports, budgeted speculative execution, and async ReAct by default. TypeScript, zero runtime deps, 108 tests.</td>
    </tr>
`;
const updated = original.slice(0, tableEnd) + row + original.slice(tableEnd);
if (updated === original) throw new Error('插入失败（内容未变化）');

// 3. 建分支
try {
  await api(`/repos/${OWNER}/${FORK}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }) });
} catch (e) {
  console.log('[awesome-pr] 分支可能已存在，继续');
}

// 4. 更新 README.md（Contents API PUT）
await api(`/repos/${OWNER}/${FORK}/contents/README.md`, {
  method: 'PUT',
  body: JSON.stringify({
    message: 'Add Shepherd to AI Agent frameworks (micro demo based on the Super-agent prototype)',
    content: Buffer.from(updated, 'utf-8').toString('base64'),
    sha: readme.sha,
    branch: BRANCH,
  }),
});
console.log('[awesome-pr] README.md updated on branch', BRANCH);

// 5. 开 PR（fork → upstream）
const prBody = [
  '## What',
  '',
  'Adds **Shepherd** to *AI Agent frameworks* — a micro demo based on DeepSeek\'s open-sourced Super-agent prototype. It implements the four pieces the article lists as future work:',
  '',
  '- external watchdog (deterministic rules + numeric-only LLM cortex, evidence-carrying interventions)',
  '- credit &times; bait verification for worker reports (catches fake "all tests pass")',
  '- budgeted speculative execution (dual trigger channels, would-do log, hit-rate)',
  '- async ReAct by default (handles, inter-step injection, seq-ordered cancellation)',
  '',
  'TypeScript, zero runtime dependencies, MIT. Not based on DeepSeek source code — an independent minimal implementation of the published architecture.',
  '',
  '## Links',
  '- Repo: https://github.com/jincheng3870682453-hash/shepherd',
  '- Benchmark report: https://github.com/jincheng3870682453-hash/shepherd/blob/main/docs/announcements/benchmark-p6.md',
  '',
  'Happy to move this to *Others* if the category is a better fit.'
].join('\n');

const pr = (await api(`/repos/${UPSTREAM}/${FORK}/pulls`, {
  method: 'POST',
  body: JSON.stringify({
    title: 'Add Shepherd — a micro demo based on the Super-agent prototype',
    head: `${OWNER}:${BRANCH}`,
    base: 'main',
    body: prBody,
  }),
})) as { html_url: string; number: number };
console.log(`[awesome-pr] PR #${pr.number}: ${pr.html_url}`);
