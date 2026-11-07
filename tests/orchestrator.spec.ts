import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { Orchestrator, type Assessor } from '../src/core/orchestrator.ts';
import { rebuildTickets } from '../src/core/tickets.ts';
import { s1Baseline, playScript } from '../src/adapters/mock-gen.ts';
import type { TurnRecord } from '../src/adapters/llm.ts';
import { ReplayModel } from '../src/adapters/llm.ts';
import { SessionRunner } from '../src/apps/runner.ts';

/** 确定性评估器 mock：request 一律 accept，noise 一律拒绝。 */
const ruleAssessor: Assessor = input =>
  input.kind === 'request'
    ? { accept: true, mandate: `完成：${input.text}` }
    : { accept: false, reason: 'not_a_request' };

describe('P2-a Router/Worker 双层：受理与 Ticket 生命周期（docs/002 §4）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-p2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('受理：trigger → opened+ack+dispatched 三事件，视图状态 open→working', () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const r = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th1', kind: 'request', text: '修 bug' }, 'trg1'), 'k1');
    assert.ok(r.kind === 'stored');
    const ticketId = orch.onTrigger(r.event.seq, r.event.id, 'th1', 'request', '修 bug');
    assert.ok(ticketId !== null);
    const t = orch.view.byId.get(ticketId)!;
    assert.equal(t.status, 'working');
    assert.equal(t.replies.length, 1); // ack
    assert.equal(t.mandate, '完成：修 bug');
    // 事件序：trigger, opened, ack(reply), dispatched
    const types = bus.allEvents().map(e => e.type);
    assert.deepEqual(types, ['source.trigger.received', 'ticket.opened', 'reply.sent', 'router.dispatched']);
    bus.close();
  });

  it('拒绝：noise → intake.filtered，不产生 Ticket', () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const r = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th2', kind: 'noise', text: '闲聊' }, 'trg2'), 'k2');
    assert.ok(r.kind === 'stored');
    const ticketId = orch.onTrigger(r.event.seq, r.event.id, 'th2', 'noise', '闲聊');
    assert.equal(ticketId, null);
    assert.equal(orch.view.byId.size, 0);
    bus.close();
  });

  it('订阅直通：同 Thread 第二条 request 并入在办 Ticket，不新开', () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const r1 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th3', kind: 'request', text: '任务A' }, 'trg3a'), 'k3a');
    const id1 = orch.onTrigger((r1 as { kind: 'stored'; event: { seq: number; id: string } }).event.seq, (r1 as { kind: 'stored'; event: { id: string } }).event.id, 'th3', 'request', '任务A');
    assert.ok(id1 !== null);
    const r2 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th3', kind: 'request', text: '补充：还要加测试' }, 'trg3b'), 'k3b');
    const id2 = orch.onTrigger((r2 as { kind: 'stored'; event: { seq: number; id: string } }).event.seq, (r2 as { kind: 'stored'; event: { id: string } }).event.id, 'th3', 'request', '补充：还要加测试');
    assert.equal(id2, id1); // 直通并入
    assert.equal(orch.view.byId.size, 1);
    assert.equal(orch.view.byId.get(id1)!.replies.length, 2); // ack + 合并 ack
    bus.close();
  });

  it('Worker 完成：ended + result 回复；Thread 订阅释放后可再开新 Ticket', () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const r1 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th4', kind: 'request', text: '任务B' }, 'trg4a'), 'k4a');
    const id1 = orch.onTrigger((r1 as { kind: 'stored'; event: { seq: number; id: string } }).event.seq, (r1 as { kind: 'stored'; event: { id: string } }).event.id, 'th4', 'request', '任务B');
    assert.ok(id1 !== null);
    orch.workerDone(id1, 'delivered', 'PR #1 已开', `tkt_${id1}`);
    assert.equal(orch.view.byId.get(id1)!.status, 'done');
    // 新请求 → 新 Ticket
    const r2 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th4', kind: 'request', text: '任务C' }, 'trg4b'), 'k4b');
    const id2 = orch.onTrigger((r2 as { kind: 'stored'; event: { seq: number; id: string } }).event.seq, (r2 as { kind: 'stored'; event: { id: string } }).event.id, 'th4', 'request', '任务C');
    assert.ok(id2 !== null && id2 !== id1);
    bus.close();
  });

  it('重放重建：从事件流 rebuildTickets 与运行时视图一致（docs/005 §4）', () => {
    const bus = new SqliteBus(join(dir, 'ev.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const r1 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 'th5', kind: 'request', text: '任务D' }, 'trg5'), 'k5');
    const id1 = orch.onTrigger((r1 as { kind: 'stored'; event: { seq: number; id: string } }).event.seq, (r1 as { kind: 'stored'; event: { id: string } }).event.id, 'th5', 'request', '任务D');
    orch.workerDone(id1!, 'delivered', '完成', `tkt_${id1}`);
    // 重放
    const rebuilt = rebuildTickets(bus.allEvents().map(e => ({ seq: e.seq, type: e.type, payload: e.payload })));
    const rt = rebuilt.byId.get(id1!)!;
    assert.deepEqual({ status: rt.status, mandate: rt.mandate, replies: rt.replies.length }, {
      status: orch.view.byId.get(id1!)!.status,
      mandate: orch.view.byId.get(id1!)!.mandate,
      replies: orch.view.byId.get(id1!)!.replies.length,
    });
    bus.close();
  });
});

describe('P2-b mock-gen：S1 基线剧本播放（docs/005 §2）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-s1-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('S1 剧本：220 Trigger 全部入总线，20 请求被受理、200 噪音被过滤', () => {
    const bus = new SqliteBus(join(dir, 's1.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const script = s1Baseline();
    const triggers = playScript(bus, script);
    assert.equal(triggers.length, 220);
    let accepted = 0;
    let filtered = 0;
    const seen = new Set<string>();
    for (const t of triggers) {
      const id = orch.onTrigger(t.seq, t.id, t.msg.thread, t.msg.kind, t.msg.text);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        accepted++;
      } else if (id === null) {
        filtered++;
      }
    }
    assert.equal(accepted, script.assertions.expectedAccepted);
    assert.equal(filtered, 200);
    assert.equal(orch.view.byId.size, 20);
    // 全链完好
    assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
    bus.close();
  });

  it('双层端到端：S1 的 20 个请求逐个走 Worker（mock 模型）→ 全部 delivered（docs/007 P2 验收的 mock 版）', async () => {
    const bus = new SqliteBus(join(dir, 's1e2e.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: ruleAssessor });
    const script = s1Baseline();
    const triggers = playScript(bus, script);

    // Worker 的 mock 剧本：每个 ticket 两轮（start 工具 → 收敛）
    const records: TurnRecord[] = [];
    const maxTickets = script.assertions.expectedAccepted;
    for (let i = 0; i < maxTickets; i++) {
      records.push({ sessionId: `worker-t-${String(i + 1).padStart(4, '0')}`, turnIndex: 0, toolStarts: [{ tool: 'file_read', args: {}, optimistic: true }] });
      records.push({ sessionId: `worker-t-${String(i + 1).padStart(4, '0')}`, turnIndex: 1, text: `任务 ${i} 完成` });
    }
    const model = new ReplayModel(records);

    let delivered = 0;
    let ticketIdx = 0;
    for (const t of triggers) {
      const ticketId = orch.onTrigger(t.seq, t.id, t.msg.thread, t.msg.kind, t.msg.text);
      if (ticketId === null) continue;
      if (orch.view.byId.get(ticketId)!.status !== 'working') continue;
      const sid = orch.view.byId.get(ticketId)!.workerSessionId;
      const executor = new ControlledExecutor();
      const worker = new SessionRunner(bus, model, {
        sessionId: sid, model: 'mock', optimisticWhitelist: ['file_read'], executor: executor.run,
      });
      await worker.start(t.id);
      const h = executor.executed[0]!.handle;
      executor.complete(h, { ok: true });
      await worker.drive();
      orch.workerDone(ticketId, 'delivered', `任务完成（${ticketId}）`, t.id);
      delivered++;
      ticketIdx++;
    }
    assert.equal(delivered, script.assertions.expectedDelivered);
    assert.equal(ticketIdx, 20);
    const all = bus.allEvents();
    assert.equal(bus.verifyChain(all, 'k').ok, true);
    const endedCount = all.filter(e => e.type === 'ticket.ended').length;
    assert.equal(endedCount, 20);
    bus.close();
  });
});

/** 受控执行器（与 e2e.spec.ts 相同实现，独立副本避免跨文件依赖） */
class ControlledExecutor {
  private readonly deferred = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly executed: Array<{ tool: string; handle: string }> = [];
  readonly run = (tool: string, _args: unknown, handle: string): Promise<unknown> => {
    this.executed.push({ tool, handle });
    return new Promise((resolve, reject) => {
      this.deferred.set(handle, { resolve, reject });
    });
  };
  complete(handle: string, value: unknown): void {
    const d = this.deferred.get(handle);
    assert.ok(d !== undefined);
    this.deferred.delete(handle);
    d.resolve(value);
  }
}
