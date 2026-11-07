import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';
import { SessionRunner } from '../src/apps/runner.ts';
import type { EventId } from '../src/core/events.ts';

/**
 * 可控执行器：deferred promise，测试显式决定何时完成/失败（真异步时序受控）。
 */
class ControlledExecutor {
  private readonly deferred = new Map<EventId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly executed: Array<{ tool: string; handle: EventId }> = [];

  readonly run = (tool: string, _args: unknown, handle: EventId): Promise<unknown> => {
    this.executed.push({ tool, handle });
    return new Promise((resolve, reject) => {
      this.deferred.set(handle, { resolve, reject });
    });
  };

  complete(handle: EventId, value: unknown): void {
    const d = this.deferred.get(handle);
    assert.ok(d !== undefined, `executor: handle ${handle} 未发起`);
    this.deferred.delete(handle);
    d.resolve(value);
  }

  fail(handle: EventId, err: Error): void {
    const d = this.deferred.get(handle);
    assert.ok(d !== undefined);
    this.deferred.delete(handle);
    d.reject(err);
  }
}

function newRunner(bus: SqliteBus, records: TurnRecord[], sessionId: string, optimistic: readonly string[], executor: ControlledExecutor): SessionRunner {
  return new SessionRunner(bus, new ReplayModel(records), {
    sessionId, model: 'mock', optimisticWhitelist: optimistic, executor: executor.run,
  });
}

describe('P1 验收：全链路演示（docs/007 P1 验收条款）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-e2e-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('一个 mock 会话跑 3 个异步工具：乱序回、归档收敛、总线全链完好', async () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const records: TurnRecord[] = [
      {
        sessionId: 'demo', turnIndex: 0,
        toolStarts: [
          { tool: 'file_read', args: { p: 'a.ts' }, optimistic: true },
          { tool: 'file_read', args: { p: 'b.ts' }, optimistic: true },
          { tool: 'cmd', args: { c: 'sleep 30' }, optimistic: false },
        ],
      },
      { sessionId: 'demo', turnIndex: 1, text: '全部结果已合并，任务完成' },
    ];
    const executor = new ControlledExecutor();
    const runner = newRunner(bus, records, 'demo', ['file_read'], executor);

    const trigger = bus.append(bus.root('source.trigger.received', 'mock-gen', { task: 'demo' }, 'evt_trigger'), 'demo:trigger');
    assert.equal(trigger.kind, 'stored');

    await runner.start('evt_trigger');
    assert.equal(executor.executed.length, 3);
    const [h1, h2, h3] = executor.executed.map(e => e.handle);
    assert.ok(h1 !== undefined && h2 !== undefined && h3 !== undefined);
    // 乐观白名单：file_read 两个 true，cmd false
    assert.equal(runner.session.handles.get(h1)!.optimistic, true);
    assert.equal(runner.session.handles.get(h3)!.optimistic, false);

    // 乱序回：h2 先完成、h1 后完成；h3 挂着
    runner.completeHandle(h2, { bytes: 2 });
    runner.completeHandle(h1, { bytes: 1 });

    const progressed = await runner.drive();
    assert.equal(progressed, false);
    assert.equal(runner.session.runningHandles(), 1); // cmd 仍在跑
    assert.equal(runner.session.archive.length, 2); // 两个已决归档
    assert.equal(runner.session.context.length, 2);

    const all = bus.allEvents();
    // 1 trigger + 3 started + 2 result = 6
    assert.equal(all.length, 6);
    assert.equal(bus.verifyChain(all, 'k').ok, true);
    bus.close();
  });

  it('取消竞态端到端：cancel 先入总线 → 迟到结果 superseded 入库不投递', async () => {
    const bus = new SqliteBus(join(dir, 'ev2.db'), 'k');
    const records: TurnRecord[] = [
      { sessionId: 'r', turnIndex: 0, toolStarts: [{ tool: 'cmd', args: {}, optimistic: false }] },
      { sessionId: 'r', turnIndex: 1, text: '已取消，改用别的办法' },
    ];
    const executor = new ControlledExecutor();
    const runner = newRunner(bus, records, 'r', [], executor);
    await runner.start('evt_x');

    const handle = executor.executed[0]!.handle;
    runner.cancelHandle(handle, 'watchdog');
    // 竞态语义：取消尚未结算（在 pending 中），等 takeBatch 按 seq 裁决（002 §3）
    assert.equal(runner.session.handles.get(handle)!.state, 'running');

    // 执行器那边也完成了（现实世界取消不了）：结果与取消都在 pending，先到算数
    executor.complete(handle, { late: true });
    await new Promise(r => setTimeout(r, 5));
    // 取消 seq 先于结果 seq → takeBatch 后 state=cancelled，结果标 superseded
    await runner.drive();
    assert.equal(runner.session.handles.get(handle)!.state, 'cancelled');
    assert.equal(runner.session.pending.length, 0);

    const all = bus.allEvents();
    const types = all.map(e => e.type);
    assert.ok(types.includes('tool.cancelled'));
    // 迟到结果带 superseded 标记（事实不丢弃，002 §3）
    const late = all.find(e => e.type === 'tool.result' && (e.payload as { superseded?: boolean }).superseded === true);
    assert.ok(late !== undefined, '迟到结果应以 superseded 标记入库');
    assert.equal(bus.verifyChain(all, 'k').ok, true);
    bus.close();
  });

  it('重放一致性：同剧本两次运行 → 总线事件流逐字段相等（剔除时间戳与 id）', async () => {
    const runOnce = async (dbPath: string, rootId: string): Promise<Array<Record<string, unknown>>> => {
      const bus = new SqliteBus(dbPath, 'k');
      const records: TurnRecord[] = [
        {
          sessionId: 'rp', turnIndex: 0,
          toolStarts: [
            { tool: 'file_read', args: { p: 'x' }, optimistic: true },
            { tool: 'net_post', args: {}, optimistic: false },
          ],
        },
        { sessionId: 'rp', turnIndex: 1, text: 'done' },
      ];
      const executor = new ControlledExecutor();
      const runner = newRunner(bus, records, 'rp', ['file_read'], executor);
      await runner.start(rootId);
      const hs = executor.executed.map(e => e.handle);
      runner.completeHandle(hs[0]!, { bytes: 9 }); // file_read 完成
      runner.cancelHandle(hs[1]!, 'watchdog');      // net_post 被取消（确定性剧本）
      await runner.drive();
      const rows = bus.allEvents().map(e => ({
        type: e.type,
        producer: e.producer,
        payload: e.payload,
        // handle 含 sessionId 计数，两跑一致；causedBy 指向 id（含 rootId），归一化
        causedByNorm: e.causedBy === null ? null : 'X',
      }));
      bus.close();
      return rows as Array<Record<string, unknown>>;
    };

    const runA = await runOnce(join(dir, 'a.db'), 'rootA');
    const runB = await runOnce(join(dir, 'b.db'), 'rootB');
    assert.deepEqual(runB, runA);
    // 事件数：1 root? 注意 root 在库外（两次运行各自 root 未 append，只算 runner 产出）
    // runner 产出：2 started + 1 result + 1 cancelled = 4
    assert.equal(runA.length, 4);
  });

  it('回放完整性：缺记录 → 明确报错不编造', async () => {
    const bus = new SqliteBus(join(dir, 'ev3.db'), 'k');
    const executor = new ControlledExecutor();
    const runner = newRunner(bus, [], 'missing', [], executor);
    await assert.rejects(() => runner.start('evt_z'), /\[replay\] 缺少回放记录/);
    bus.close();
  });
});
