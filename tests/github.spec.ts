import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { GitHubSource } from '../src/adapters/github.ts';
import { SqliteBus } from '../src/adapters/store.ts';

/** 本地 mock GitHub API server（零外网依赖）。 */
function mockGitHub(): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      if (url.startsWith('/repos/o/r/issues?')) {
        res.end(JSON.stringify([
          { id: 9001, number: 42, title: 'Bug: 登录失败', body: '复现步骤……', user: { login: 'alice' }, html_url: 'https://github.com/o/r/issues/42', pull_request: undefined },
        ]));
      } else if (url.startsWith('/repos/o/r/issues/comments')) {
        res.end(JSON.stringify([
          { id: 7001, created_at: new Date(Date.now() - 60_000).toISOString(), body: '我来修这个', user: { login: 'bob' }, html_url: 'https://github.com/o/r/issues/42#comment', issue_url: 'https://api.github.com/repos/o/r/issues/42' },
        ]));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

describe('P3-b GitHub 轮询源（docs/005 §2）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-gh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺 token → 结构化 problem，不静默启动（github_scout 反问模式）', () => {
    const bus = new SqliteBus(join(dir, 'a.db'), 'k');
    delete process.env['GITHUB_TOKEN'];
    const s2 = new GitHubSource(bus, { repo: 'o/r', baseUrl: 'http://127.0.0.1:1' });
    assert.ok(s2.problem !== null);
    bus.close();
  });

  it('仓库标识不合法 → 结构化 problem', () => {
    const bus = new SqliteBus(join(dir, 'b.db'), 'k');
    const src = new GitHubSource(bus, { repo: 'not-a-repo', token: 't' });
    assert.ok(src.problem?.includes('owner/repo'));
    bus.close();
  });

  it('轮询：issue + comment → 2 个 Trigger 入总线，自然键幂等（重轮不重复）', async () => {
    const { server, port } = await mockGitHub();
    const bus = new SqliteBus(join(dir, 'c.db'), 'k');
    const src = new GitHubSource(bus, { repo: 'o/r', token: 't', baseUrl: `http://127.0.0.1:${port}`, horizonMs: 3600_000 });
    const n1 = await src.pollOnce();
    assert.equal(n1, 2);
    // 立即重轮：horizon 内、自然键相同 → 0 新增
    const n2 = await src.pollOnce();
    assert.equal(n2, 0);
    const triggers = bus.allEvents().filter(e => e.type === 'source.trigger.received');
    assert.equal(triggers.length, 2);
    const kinds = triggers.map(e => (e.payload as { kind: string }).kind).sort();
    assert.deepEqual(kinds, ['comment', 'issue']);
    // 事件里没有 token 泄漏（005 §2 红线）
    const raw = JSON.stringify(bus.allEvents());
    assert.ok(!raw.includes('Bearer'));
    assert.ok(!raw.includes('"t"'));
    server.close();
    bus.close();
  });

  it('API 失败 → 结构化 problem（下一轮可重试），不崩进程', async () => {
    const bus = new SqliteBus(join(dir, 'd.db'), 'k');
    const src = new GitHubSource(bus, { repo: 'o/r', token: 't', baseUrl: 'http://127.0.0.1:1', horizonMs: 1000 });
    const n = await src.pollOnce();
    assert.equal(n, 0);
    assert.ok(src.problem?.startsWith('轮询失败'));
    bus.close();
  });
});
