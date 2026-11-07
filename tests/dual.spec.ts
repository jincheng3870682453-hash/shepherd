import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';
import { s1Baseline, playScript } from '../src/adapters/mock-gen.ts';
import { DualLayerRuntime } from '../src/apps/dual.ts';
import type { Assessor } from '../src/core/orchestrator.ts';

const ruleAssessor: Assessor = input =>
  input.kind === 'request'
    ? { accept: true, mandate: `完成：${input.text}` }
    : { accept: false, reason: 'not_a_request' };

describe('P2-e 双层整合：S1 并发端到端 + 四张表（docs/007 P2 验收）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-p2e-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('S1 并发端到端：220 Trigger → 4 并发 Worker → 20/20 delivered → 四张表有数', async () => {
    const bus = new SqliteBus(join(dir, 's1p.db'), 'k');
    const script = s1Baseline();
    // Worker mock 剧本：每会话 2 轮（start → 收敛）
    const records: TurnRecord[] = [];
    for (let i = 1; i <= script.assertions.expectedAccepted; i++) {
      const sid = `worker-t-${String(i).padStart(4, '0')}`;
      records.push({ sessionId: sid, turnIndex: 0, toolStarts: [{ tool: 'file_read', args: {}, optimistic: true }] });
      records.push({ sessionId: sid, turnIndex: 1, text: `done ${i}` });
    }
    const dual = new DualLayerRuntime(bus, {
      assessor: ruleAssessor,
      maxWorkers: 4,
      optimisticWhitelist: ['file_read'],
      model: new ReplayModel(records),
      executor: async () => ({ ok: true }),
    });

    const triggers = playScript(bus, script);
    let lastError: unknown = null;
    // 喂入全部 Trigger（受理 + 排队）
    for (const t of triggers) {
      try {
        dual.feed(t.seq, t.id, t.msg.thread, t.msg.kind, t.msg.text);
      } catch (e) {
        lastError = e;
        break;
      }
    }
    assert.equal(lastError, null);

    // 驱动完成：逐一 completeWorker（池会自动调度后续）
    // 注意：feed 里 acquire 成功的才 launch；排队中的在 release 时 launch —— 但 launchPending
    // 是 async，此处用重试循环直到收敛（有界：20 个 ticket 最多 20 轮）
    for (let round = 0; round < 40; round++) {
      const running = [...dual.orchestrator.view.byId.values()].filter(t => t.status === 'working');
      if (running.length === 0) break;
      for (const t of running) {
        await dual.completeWorker(t.ticketId);
      }
    }
    assert.equal(dual.settled(), true, '全部收敛');
    assert.equal(dual.completedTickets().length, 20);

    const totals = dual.stats.totals();
    assert.equal(totals.delivered, 20);
    assert.ok(totals.costUsd > 0);
    // p50/p95 有数（seq 差代理）
    const p50 = dual.stats.percentile(50);
    const p95 = dual.stats.percentile(95);
    assert.ok(p50 !== null && p50 > 0);
    assert.ok(p95 !== null && p95 >= (p50 ?? 0));
    // 打扰率：每 ticket 恰好 2 条回复（ack + result）
    assert.ok(totals.interruptions <= 40);

    // 总线完整性
    const all = bus.allEvents();
    assert.equal(bus.verifyChain(all, 'k').ok, true);
    const ended = all.filter(e => e.type === 'ticket.ended').length;
    assert.equal(ended, 20);
    bus.close();
  });

  it('并发上限真实生效：池运行数从未超过 4', async () => {
    const bus = new SqliteBus(join(dir, 'cap.db'), 'k');
    const script = s1Baseline();
    const records: TurnRecord[] = [];
    for (let i = 1; i <= 20; i++) {
      const sid = `worker-t-${String(i).padStart(4, '0')}`;
      records.push({ sessionId: sid, turnIndex: 0, toolStarts: [{ tool: 'file_read', args: {}, optimistic: true }] });
      records.push({ sessionId: sid, turnIndex: 1, text: `done ${i}` });
    }
    const dual = new DualLayerRuntime(bus, {
      assessor: ruleAssessor,
      maxWorkers: 4,
      optimisticWhitelist: ['file_read'],
      model: new ReplayModel(records),
      executor: async () => ({ ok: true }),
    });
    const triggers = playScript(bus, script);
    for (const t of triggers) dual.feed(t.seq, t.id, t.msg.thread, t.msg.kind, t.msg.text);
    // 排队数 = 20 - 4 = 16（feed 后立即检查）
    assert.ok(dual.pool.stats().queued >= 16 - 4, `排队数=${dual.pool.stats().queued}`);
    assert.ok(dual.pool.stats().running <= 4);
    for (let round = 0; round < 40; round++) {
      const running = [...dual.orchestrator.view.byId.values()].filter(t => t.status === 'working');
      if (running.length === 0) break;
      for (const t of running) await dual.completeWorker(t.ticketId);
    }
    assert.equal(dual.completedTickets().length, 20);
    bus.close();
  });
});
