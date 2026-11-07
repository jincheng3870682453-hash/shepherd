import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';

/**
 * 假 HooH MCP server：按 ace/docs/MCP-SERVER.md 的协议语义回话（行 JSON-RPC）。
 * 剧本可编程：第 N 次 tools/call 返回什么。
 */
class FakeHoohServer {
  private buffer = '';
  callCount = 0;
  /** 每次调用的应答剧本（循环取用）。 */
  script: Array<{ isError?: boolean; text: string }> = [];

  readonly onData = (chunk: string, write: (s: string) => void): void => {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '') continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method === 'initialize') {
        write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ace', version: '9.9.9-fake' } },
        }) + '\n');
      } else if (msg.method === 'tools/list') {
        write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'file_read' }, { name: 'file_write' }] } }) + '\n');
      } else if (msg.method === 'tools/call') {
        const s = this.script[this.callCount % this.script.length]!;
        this.callCount++;
        write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: s.text }], ...(s.isError ? { isError: true } : {}) },
        }) + '\n');
      } else if (msg.method === 'ping') {
        write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      }
      // 通知（notifications/initialized）不应答
    }
  };
}

// HoohMcpClient 用 spawn 起真子进程；沙盒里 spawn 受限。为测协议语义，
// 用一个进程内桩替换 transport 层：直接构造 client 并注入假管道。
// 更直接：把 FakeHoohServer 的应答行为做成 HoohMcpClient 的依赖注入点 ——
// 这里用最小的反射 hack：new HoohMcpClient 后替换其私有 request 实现。

import { HoohMcpClient } from '../src/adapters/hooh.ts';

describe('P3-a HooH-MCP 客户端语义（docs/ADR-004 协议对接）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-hooh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 构造一个"传输层被桩替换"的 client（协议逻辑与真客户端同源）。 */
  function makeClient(responder: (method: string, params: Record<string, unknown>) => unknown): { client: HoohMcpClient; bus: SqliteBus } {
    const bus = new SqliteBus(join(dir, `hooh-${Math.random().toString(36).slice(2)}.db`), 'k');
    const client = new HoohMcpClient(bus, {
      pythonPath: 'python', serverScript: 'ai_code.py', projectRoot: dir, permission: 'readonly',
    });
    // 桩：替换私有 request（协议处理在真实现里，这里只挡住 spawn）
    const anyClient = client as unknown as { request: (m: string, p: unknown) => Promise<unknown>; started: boolean };
    anyClient.started = true;
    anyClient.request = async (method: string, params: unknown) => responder(method, params as Record<string, unknown>);
    return { client, bus };
  }

  it('allow：正常结果 → decision=allow，hooh.decided 事件入总线，denyStreak 清零', async () => {
    const { client, bus } = makeClient((_m, p) => {
      if ((p as { name?: string }).name === 'file_read') return { content: [{ type: 'text', text: 'hello' }] };
      if ((p as { method?: string }).method === undefined && (p as { protocolVersion?: string }).protocolVersion !== undefined) {
        return { protocolVersion: '2025-06-18' };
      }
      return {};
    });
    const r = await client.callTool('file_read', { path: 'a.txt' }, 'evt_x');
    assert.equal(r.decision, 'allow');
    assert.equal(client.currentDenyStreak(), 0);
    const ev = bus.allEvents().find(e => e.type === 'hooh.decided');
    assert.ok(ev !== undefined);
    assert.equal((ev.payload as { decision: string }).decision, 'allow');
    bus.close();
  });

  it('asked：PERMISSION_REQUEST 文本 → decision=asked（headless fail-close 的显式形状）', async () => {
    const { client, bus } = makeClient(() => ({
      isError: true,
      content: [{ type: 'text', text: '{"status": "PERMISSION_REQUEST"}\n[HooH] 本次调用没有人可以确认…' }],
    }));
    const r = await client.callTool('terminal_exec', { command: 'rm -rf /' }, 'evt_x');
    assert.equal(r.decision, 'asked');
    assert.equal(client.currentDenyStreak(), 1);
    bus.close();
  });

  it('deny：其他 isError → decision=deny；连击计数累加（Watchdog 遥测源）', async () => {
    const { client, bus } = makeClient(() => ({
      isError: true,
      content: [{ type: 'text', text: 'sensitive target blocked' }],
    }));
    await client.callTool('file_write', { path: '/etc/passwd' }, 'evt_x');
    await client.callTool('file_write', { path: '/etc/shadow' }, 'evt_x');
    await client.callTool('file_write', { path: '/root/.ssh' }, 'evt_x');
    assert.equal(client.currentDenyStreak(), 3);
    const decided = bus.allEvents().filter(e => e.type === 'hooh.decided');
    assert.equal(decided.length, 3);
    assert.ok(decided.every(e => (e.payload as { decision: string }).decision === 'deny'));
    bus.close();
  });

  it('allow 后连击清零（试探中断不累计）', async () => {
    let n = 0;
    const { client, bus } = makeClient(() => {
      n++;
      if (n % 2 === 1) return { isError: true, content: [{ type: 'text', text: 'denied' }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    await client.callTool('file_write', {}, 'evt_x'); // deny
    await client.callTool('file_read', {}, 'evt_x');  // allow → 清零
    await client.callTool('file_write', {}, 'evt_x'); // deny
    assert.equal(client.currentDenyStreak(), 1);
    bus.close();
  });
});
