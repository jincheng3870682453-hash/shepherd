/**
 * GitHub 轮询源（adapters）—— docs/005 §2。
 *
 * 设计（对齐上游 poll.ts + 本方 github_scout.py）：
 *   - 轮询而非 webhook（零公网部署成本；上游原型同款取舍）；
 *   - POLL_HORIZON 防漏（轮询窗口重叠由自然键幂等去重兜底——总线的铁律 1）；
 *   - token 只进本进程，事件里永不出现（005 §2 红线）；
 *   - GitHub API via Node fetch，REST：issues/comments + pulls；
 *   - github_scout 思想：拉不到的先反问（缺 token/仓库不可达 → 结构化 problem，不静默）。
 */
import type { BusLike } from '../apps/runner.ts';

export interface GitHubSourceOptions {
  readonly token?: string; // 缺省读 GITHUB_TOKEN
  readonly repo: string; // "owner/repo"
  readonly pollIntervalMs?: number;
  /** 回看窗口（毫秒）：首次轮询拉多远的事件。 */
  readonly horizonMs?: number;
  readonly baseUrl?: string; // 缺省 https://api.github.com（测试可换 mock server）
}

export interface GitHubTrigger {
  readonly naturalKey: string;
  readonly thread: string;
  readonly kind: 'comment' | 'issue';
  readonly sender: string;
  readonly text: string;
  readonly url: string;
}

export class GitHubSource {
  private readonly bus: BusLike;
  private readonly opts: GitHubSourceOptions;
  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly interval: number;
  private readonly horizon: number;
  private lastPollAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 结构化问题（github_scout 反问模式：不可达/缺凭据 → 明说，不静默）。 */
  problem: string | null = null;

  constructor(bus: BusLike, opts: GitHubSourceOptions) {
    this.bus = bus;
    this.opts = opts;
    this.token = opts.token ?? process.env['GITHUB_TOKEN'] ?? null;
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com';
    this.interval = opts.pollIntervalMs ?? 30_000;
    this.horizon = opts.horizonMs ?? 3600_000;
    if (this.token === null) {
      this.problem = 'GITHUB_TOKEN 未设置：轮询源无法启动（凭据不落盘，走环境变量——005 §2 红线）';
    }
    if (!/^[^/]+\/[^/]+$/.test(opts.repo)) {
      this.problem = `仓库标识不合法: ${opts.repo}（应为 owner/repo——github_scout 反问模式）`;
    }
  }

  /** 单轮轮询：拉 issue 评论与新 issue → Trigger 入总线（自然键幂等）。返回本轮新 Trigger 数。 */
  async pollOnce(now: number = Date.now()): Promise<number> {
    if (this.problem !== null) return 0;
    const since = this.lastPollAt ?? now - this.horizon;
    this.lastPollAt = now;
    let count = 0;
    try {
      // 1. 新 issue（作为 Trigger + Thread 起点）
      const issues = await this.api(`/repos/${this.opts.repo}/issues?since=${new Date(since).toISOString()}&state=all&per_page=50`);
      for (const it of issues as Array<Record<string, unknown>>) {
        if (it['pull_request'] !== undefined) continue; // PR 走 pulls（P3-c 扩展）
        count += this.emit({
          naturalKey: `gh:${this.opts.repo}:issue:${it['id']}`,
          thread: `gh:${this.opts.repo}#${it['number']}`,
          kind: 'issue',
          sender: (it['user'] as Record<string, unknown>)?.['login'] as string ?? 'unknown',
          text: String(it['title'] ?? '') + '\n' + String(it['body'] ?? ''),
          url: String(it['html_url'] ?? ''),
        });
      }
      // 2. issue 评论（Thread 后续）
      const comments = await this.api(`/repos/${this.opts.repo}/issues/comments?sort=created&direction=desc&per_page=50`);
      for (const c of comments as Array<Record<string, unknown>>) {
        const created = new Date(String(c['created_at'])).getTime();
        if (created < since) continue;
        const issueUrl = String(c['issue_url'] ?? '');
        const number = issueUrl.split('/').pop();
        count += this.emit({
          naturalKey: `gh:${this.opts.repo}:comment:${c['id']}`,
          thread: `gh:${this.opts.repo}#${number}`,
          kind: 'comment',
          sender: (c['user'] as Record<string, unknown>)?.['login'] as string ?? 'unknown',
          text: String(c['body'] ?? ''),
          url: String(c['html_url'] ?? ''),
        });
      }
    } catch (e) {
      // 轮询失败不静默：记 problem（结构化），下轮重试
      this.problem = `轮询失败: ${String(e).slice(0, 200)}`;
      return count;
    }
    return count;
  }

  private emit(t: GitHubTrigger): number {
    const r = this.bus.append(
      this.bus.root('source.trigger.received', `github:${this.opts.repo}`, { naturalKey: t.naturalKey, thread: t.thread, kind: t.kind, text: t.text, url: t.url }, `gh_${t.naturalKey.replace(/[^a-zA-Z0-9]/g, '_')}`),
      t.naturalKey,
    );
    return r.kind === 'stored' ? 1 : 0;
  }

  private async api(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.token !== null ? { Authorization: `Bearer ${this.token}` } : {}),
        'User-Agent': 'shepherd-poller',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return res.json();
  }

  start(): void {
    if (this.problem !== null || this.timer !== null) return;
    this.timer = setInterval(() => void this.pollOnce(), this.interval);
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
