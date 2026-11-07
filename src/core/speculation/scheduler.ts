/**
 * 投机执行调度器（core/speculation）—— 带预算的后台任务（docs/004 §3、docs/002 §6）。
 *
 * 双通道触发（004 旗舰二）：
 *   A. 显式规则：团队写的触发规则（如"群里讨论 Bug 时后台先复现"）；
 *   B. 评估模型提议：受理评估顺带判断"这个 Thread 值得投机探索吗"。
 * 交付门槛：诱饵/复现验证（verifyBait 语义）；丢弃进 would-do 日志（命中率仪表盘）。
 * 预算：budgetFor(credit).speculationTokens，池干涸即投机静默——永不挤占正式工作。
 */
import type { CreditEngine } from '../credit/tier.ts';
import { budgetFor } from '../credit/budget.ts';

export interface SpeculationOpportunity {
  readonly opportunityId: string;
  readonly sourceThread: string;
  /** 触发通道。 */
  readonly via: 'rule' | 'assessor';
  /** 规则 id 或评估器理由。 */
  readonly trigger: string;
  /** 投机任务描述（做什么）。 */
  readonly intent: string;
  /** 交付门槛描述（怎么验证）。 */
  readonly verifyHint: string;
}

export type SpeculationState = 'proposed' | 'started' | 'delivered' | 'dropped';

export interface SpeculationTask extends SpeculationOpportunity {
  readonly state: SpeculationState;
  readonly startedSeq: number;
  readonly tokensSpent: number;
  readonly endReason?: string | undefined;
}

export interface SpeculationOptions {
  /** 全局投机池（token/日）。 */
  readonly dailyPoolTokens: number;
  /** 最大并发投机任务。 */
  readonly maxConcurrent: number;
}

export class SpeculationScheduler {
  private readonly tasks = new Map<string, SpeculationTask>();
  private poolRemaining: number;
  private readonly engine: CreditEngine;
  private readonly nowMs: number;
  private readonly opts: SpeculationOptions;

  constructor(engine: CreditEngine, opts: SpeculationOptions, nowMs: number) {
    this.engine = engine;
    this.opts = opts;
    this.nowMs = nowMs;
    this.poolRemaining = opts.dailyPoolTokens;
  }

  /** 双通道入口：提议一个投机机会。预算/并发/信用三重门控。 */
  propose(op: SpeculationOpportunity, sourceCredit: number): { accepted: boolean; reason: string } {
    const budget = budgetFor(sourceCredit);
    // 门控 1：源信用过低 → 投机预算近零（平方曲线自然淘汰）
    if (budget.speculationTokens < 1000) {
      this.mark(op, 'proposed', 0, `credit ${sourceCredit} too low (budget ${budget.speculationTokens})`);
      return { accepted: false, reason: `speculation budget too low for credit ${sourceCredit} (budget ${budget.speculationTokens})` };
    }
    // 门控 2：并发上限
    const running = [...this.tasks.values()].filter(t => t.state === 'started').length;
    if (running >= this.opts.maxConcurrent) {
      this.mark(op, 'proposed', 0, 'concurrency cap');
      return { accepted: false, reason: `concurrency cap ${this.opts.maxConcurrent}` };
    }
    // 门控 3：池干涸
    const reserve = Math.min(budget.speculationTokens, this.poolRemaining);
    if (reserve < 1000) {
      this.mark(op, 'proposed', 0, 'pool dry');
      return { accepted: false, reason: 'speculation pool dry — stays silent (never crowds real work)' };
    }
    this.poolRemaining -= reserve;
    this.mark(op, 'started', reserve, undefined);
    return { accepted: true, reason: `started with ${reserve} tokens` };
  }

  /** 投机完成：交付或丢弃（都要过 verifyHint 的门槛——这里由调用方跑验证）。 */
  settle(opportunityId: string, delivered: boolean, tokensSpent: number, reason: string): void {
    const t = this.tasks.get(opportunityId);
    if (t === undefined) throw new Error(`[speculation] 未知任务: ${opportunityId}`);
    if (t.state !== 'started') throw new Error(`[speculation] 任务 ${opportunityId} 状态 ${t.state} 不可结算`);
    (t as { state: SpeculationState }).state = delivered ? 'delivered' : 'dropped';
    (t as { endReason?: string }).endReason = reason;
    // 未花完的预算回池
    this.poolRemaining += Math.max(0, t.tokensSpent - tokensSpent);
  }

  private mark(op: SpeculationOpportunity, state: SpeculationState, tokens: number, reason?: string): SpeculationTask {
    const t: SpeculationTask = { ...op, state, startedSeq: 0, tokensSpent: tokens, ...(reason !== undefined ? { endReason: reason } : {}) };
    this.tasks.set(op.opportunityId, t);
    return t;
  }

  /** 命中率仪表盘数据（would-do 日志 = dropped 任务集）。 */
  dashboard(): { total: number; started: number; delivered: number; dropped: number; poolRemaining: number; hitRate: number | null } {
    const all = [...this.tasks.values()];
    const started = all.filter(t => t.state === 'started').length;
    const delivered = all.filter(t => t.state === 'delivered').length;
    const dropped = all.filter(t => t.state === 'dropped').length;
    const settled = delivered + dropped;
    return {
      total: all.length,
      started,
      delivered,
      dropped,
      poolRemaining: this.poolRemaining,
      hitRate: settled > 0 ? delivered / settled : null,
    };
  }

  /** would-do 日志（丢弃任务的意图清单——命中率数据的原始形态）。 */
  wouldDoLog(): ReadonlyArray<{ id: string; intent: string; reason: string | undefined }> {
    return [...this.tasks.values()].filter(t => t.state === 'dropped').map(t => ({ id: t.opportunityId, intent: t.intent, reason: t.endReason }));
  }
}
