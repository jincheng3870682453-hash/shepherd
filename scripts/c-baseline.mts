/**
 * C 组对照基线（docs/006 §3）—— 复刻上游"单 Session + Subagent 工具"方案，
 * 与 A 组（Shepherd 双层）跑同一 S1 剧本。上游实验实录（006 §1）：
 *   中性提示下 5 次运行 0 次调用 Subagent——全部在主 Session 干、不断被新消息打断，
 *   p95 达 29.5 分钟；改为优先委派后 4/5 次委派，仍慢于双层。
 *
 * 复刻口径（mock LLM，事件全入总线，与 A 组同剧本同判分）：
 *   单会话串行消费 Trigger：每条 Trigger 一轮 LLM 决策；
 *   "Subagent 工具"= 决策含 toolStarts(subagent) 时把任务派给异步句柄（等价上游
 *   Agent Team 的委派路径）；中性提示=每条都自己干（0/5 委派的复刻）；
 *   优先委派=每条都委派（4/5 的复刻）。
 * 产出：交付时间 seq 差分布 + 打扰数 + 成本，与 A 组同表对照。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';
import { SessionRunner } from '../src/apps/runner.ts';
import { s1Baseline as s1BaselineImport } from '../src/adapters/mock-gen.ts';import type { EventDraft, EventId } from '../src/core/events.ts';

/** C 组：单会话循环——逐条消费 Trigger，按策略决定"自己干"或"委派 subagent"。 */
class SingleSessionBaseline {
  private readonly bus: SqliteBus;
  private seqCounter = 0;

  constructor(bus: SqliteBus) {
    this.bus = bus;
  }

  private nextSeq(): number {
    return ++this.seqCounter;
  }

  private append(type: string, producer: string, payload: unknown, id: string, causedBy: string): number {
    const draft = {
      id, type, ts: new Date().toISOString(), ingestedAt: new Date().toISOString(),
      producer, causedBy, payload,
    } as unknown as EventDraft;
    const r = this.bus.append(draft);
    return r.kind === 'stored' ? r.event.seq : -1;
  }

  /**
   * 跑 S1：mode='self'（中性提示：全部自己干，串行阻塞）| 'delegate'（优先委派）。
   * 返回完成时间 seq 差数组与打扰总数。
   */
  runS1(mode: 'self' | 'delegate'): { deltas: number[]; interruptions: number; events: number } {
    const script = s1BaselineImport();
    const deltas: number[] = [];
    let interruptions = 0;

    // 单会话消费：所有 Trigger 顺序进同一"主会话"。
    // self 模式：每个请求独占会话直到完成（阻塞后续）——这是上游观察到的真实行为；
    // delegate 模式：委派给 subagent 句柄（并行），但主会话仍要为每条消息付一轮决策。
    const pending: Array<{ triggerSeq: number; triggerId: string; msgIdx: number }> = [];

    for (const [msgIdx, msg] of script.messages.entries()) {
      const triggerSeq = this.nextSeq();
      const triggerId = `c_trg_${triggerSeq}`;
      this.append('source.trigger.received', 'mock-gen', { thread: msg.thread, kind: msg.kind, text: msg.text }, triggerId, 'c_root');

      const isRequest = msg.kind === 'request';
      if (!isRequest) {
        // 单会话对噪音也要付一轮注意力（上游实验：主会话被新消息打断）
        this.append('intake.accepted', 'single-session', { note: 'noise consumes a turn' }, `c_noise_${triggerSeq}`, triggerId);
        interruptions++;
        continue;
      }

      if (mode === 'delegate') {
        // 委派：subagent 工具启动 + 完成两事件（id 各自独立，防撞）
        this.append('tool.started', 'single-session', { tool: 'subagent', task: msg.text }, `c_sa_start_${triggerSeq}`, triggerId);
        const doneSeq = this.append('tool.result', 'subagent', { handle: `sa_${triggerSeq}`, result: 'done' }, `c_sa_done_${triggerSeq}`, `c_sa_start_${triggerSeq}`);
        const replySeq = this.append('reply.sent', 'single-session', { ticketId: `c-${msg.thread}`, purpose: 'result', text: 'done', thread: msg.thread }, `c_sa_reply_${triggerSeq}`, `c_sa_done_${triggerSeq}`);
        deltas.push(Math.max(1, replySeq - triggerSeq));
        interruptions += 2; // ack + result
      } else {
        // 自己干：串行阻塞——完成事件在"处理完前面所有请求"之后
        pending.push({ triggerSeq, triggerId, msgIdx });
      }
    }

    if (mode === 'self') {
      // 串行：第 i 个请求的完成 seq = triggerSeq + 累计处理时间（每请求 5 事件处理链）
      let cursor = 0;
      for (const p of pending) {
        const start = Math.max(p.triggerSeq, cursor);
        const doneSeq = start + 5; // 处理链：think/act/verify/fix/report 5 步（mock）
        this.append('reply.sent', 'single-session', { ticketId: `c-self-${p.msgIdx}`, purpose: 'result', text: 'done', thread: script.messages[p.msgIdx]!.thread }, `c_done_${p.msgIdx}`, p.triggerId);
        deltas.push(Math.max(1, doneSeq - p.triggerSeq));
        cursor = doneSeq;
        interruptions += 1;
      }
    }

    return { deltas, interruptions, events: this.seqCounter };
  }

  percentile(deltas: number[], p: number): number {
    if (deltas.length === 0) return 0;
    const sorted = [...deltas].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  }
}

// ── 跑分 ──────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'c-baseline-'));
const results: Array<{ group: string; mode: string; p50: number; p95: number; interruptions: number; delivered: number }> = [];

for (const mode of ['self', 'delegate'] as const) {
  const bus = new SqliteBus(join(dir, `c-${mode}.db`), 'k');
  const baseline = new SingleSessionBaseline(bus);
  const r = baseline.runS1(mode);
  results.push({
    group: 'C', mode, p50: baseline.percentile(r.deltas, 50), p95: baseline.percentile(r.deltas, 95),
    interruptions: r.interruptions, delivered: r.deltas.length,
  });
  if (r.deltas.length !== 20) throw new Error(`{${mode}}: 20 requests should all be delivered, got ${r.deltas.length}`);
  bus.close();
}
function assertBuildOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A 组数字（来自 tests/dual.spec.ts 的 S1 并发端到端——同剧本同判分口径）：
// 20/20 delivered；打扰=2 条/Ticket（ack+result）；完成时间 seq 差由 dual 记录
results.push({ group: 'A', mode: 'dual-layer-4-workers', p50: 12, p95: 16, interruptions: 40, delivered: 20 });

console.log('=== C 组对照表（docs/006 §3 补完） ===');
console.table(results);
rmSync(dir, { recursive: true, force: true });
console.log('C-BASELINE OK');
