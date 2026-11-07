import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type HandleRecord, type PendingEvent, type SessionHost } from '../src/core/session.ts';

/** 记账式 Host：只统计 stopHandle 调用，白名单固定。 */
class RecordingHost implements SessionHost {
  stopped: string[] = [];
  private readonly optimisticTools: readonly string[];
  constructor(optimisticTools: readonly string[]) {
    this.optimisticTools = optimisticTools;
  }
  isOptimisticAllowed(tool: string): boolean {
    return this.optimisticTools.includes(tool);
  }
  stopHandle(handle: string): void {
    this.stopped.push(handle);
  }
}

describe('P1-b 会话内核：异步工具语义（docs/002 §3）', () => {
  it('start 记句柄、结果步间注入、句柄 resolved', () => {
    const host = new RecordingHost(['file_read']);
    const s = new Session('w1', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'file_read', args: { p: 'a.ts' }, optimistic: true }] });
    assert.equal(s.status, 'running');
    const handle = [...s.handles.keys()][0]!;
    const rec = s.handles.get(handle)!;
    assert.equal(rec.optimistic, true); // 白名单允许 → 乐观成立

    s.deliver(10, 'tool.result', handle, { bytes: 42 });
    // 语义：running 中收到结果不改状态（还在跑），状态机在 takeBatch 后收敛（002 §3）
    assert.equal(s.status, 'running');
    const batch = s.takeBatch();
    assert.equal(batch.injected.length, 1);
    assert.equal(rec.state, 'resolved');
    assert.equal(s.context.length, 1);
    assert.equal(s.cursorSeq, 10);
    assert.equal(s.status, 'idle'); // 全部句柄已决 → 收敛
  });

  it('取消竞态：cancel(seq5) 先到 → result(seq7) 标 superseded（先到算数）', () => {
    const host = new RecordingHost([]);
    const s = new Session('w2', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'net_post', args: {}, optimistic: false }] });
    const handle = [...s.handles.keys()][0]!;

    // 结果先到（seq5）
    s.deliver(5, 'tool.result', handle, { ok: true });
    s.takeBatch();
    // 迟到的取消（seq7）
    s.deliver(7, 'tool.cancelled', handle, {});
    const batch2 = s.takeBatch();
    assert.equal(batch2.superseded.length, 1);
    assert.equal(s.handles.get(handle)!.state, 'resolved');
  });

  it('乐观标记被白名单收口：模型声称乐观但工具不在白名单 → 不乐观（ADR-003 fail-close）', () => {
    const host = new RecordingHost(['file_read']);
    const s = new Session('w3', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'file_write', args: {}, optimistic: true }] });
    const rec = [...s.handles.values()][0]!;
    assert.equal(rec.optimistic, false);
  });

  it('stop：模型主动取消运行中句柄 → Host 被通知', () => {
    const host = new RecordingHost([]);
    const s = new Session('w4', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'cmd', args: {}, optimistic: false }] });
    const handle = [...s.handles.keys()][0]!;
    s.applyTurn(1, { toolStops: [{ handle, reason: 'too slow' }] });
    assert.deepEqual(host.stopped, [handle]);
    assert.equal(s.handles.get(handle)!.state, 'cancelled');
    assert.equal(s.runningHandles(), 0);
    assert.equal(s.status, 'idle');
  });

  it('归档：已决句柄压摘要，运行中不动', () => {
    const host = new RecordingHost(['file_read']);
    const s = new Session('w5', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'file_read', args: { p: 'a.ts' }, optimistic: true }, { tool: 'cmd', args: {}, optimistic: false }] });
    const [h1, h2] = [...s.handles.keys()];
    s.deliver(3, 'tool.result', h1, {});
    s.takeBatch();
    const n = s.archiveResolved(rec => `read ${rec.tool}`);
    assert.equal(n, 1);
    assert.equal(s.archive.length, 1);
    assert.equal(s.archive[0]!.summary, 'read file_read');
    assert.equal(s.runningHandles(), 1); // cmd 还在跑
  });

  it('孤儿清理：会话结束时全部未决句柄取消并通知 Host', () => {
    const host = new RecordingHost([]);
    const s = new Session('w6', host);
    s.applyTurn(0, { toolStarts: [{ tool: 'cmd', args: {}, optimistic: false }, { tool: 'cmd2', args: {}, optimistic: false }] });
    const orphans = s.orphanHandles();
    assert.equal(orphans.length, 2);
    assert.equal(host.stopped.length, 2);
    assert.equal(s.runningHandles(), 0);
  });

  it('乱序注入按 seq 排序合并', () => {
    const host = new RecordingHost([]);
    const s = new Session('w7', host);
    s.deliver(30, 'injected', undefined, { order: 'c' });
    s.deliver(10, 'injected', undefined, { order: 'a' });
    s.deliver(20, 'injected', undefined, { order: 'b' });
    const batch = s.takeBatch();
    assert.deepEqual(batch.injected.map(e => (e.payload as { order: string }).order), ['a', 'b', 'c']);
    assert.equal(s.cursorSeq, 30);
  });
});
