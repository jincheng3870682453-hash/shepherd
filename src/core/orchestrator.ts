/**
 * Orchestrator —— Router 角色的编排语义（core，零 I/O）。
 *
 * 职责（docs/002 §4）：
 *   受理评估（评估器注入，v1 是轻模型客户端；上游 MasterAssessor 模式的简化版）
 *   → accept：ticket.opened + reply.sent(ack) + router.dispatched
 *   → reject：intake.filtered{stage: router_assess}
 *   订阅直通：Thread→Ticket 记录；同 Thread 后续 Trigger 直达对应 Ticket（005 §3）
 *   Worker 完成 → ticket.ended + reply.sent(result)
 *
 * Router 不干活（无写类工具）：它只产出这些事件，执行在 Worker（SessionRunner）。
 */
import type { BusLike } from '../apps/runner.ts';
import type { EventId } from './events.ts';
import type { TicketView } from './tickets.ts';
import { applyTicketEvent, newTicketView, rebuildTickets } from './tickets.ts';
import { RuleGate } from './filter/rule-gate.ts';
import { AmbiguityRouter } from './filter/ambiguity.ts';

/** 入口过滤结果（Orchestrator.onTrigger 的三路出口）。cleaned = 截断/清洗后的文本。 */
export type IntakeVerdict =
  | { readonly action: 'filtered'; readonly stage: 'rule_gate' | 'ambiguity'; readonly reason: string }
  | { readonly action: 'clarify'; readonly reason: string; readonly prompt: string }
  | { readonly action: 'assess'; readonly cleaned: string };

export interface AssessInput {
  readonly triggerId: EventId;
  readonly thread: string;
  readonly kind: string;
  readonly text: string;
  readonly fromWorker: boolean;
}

/** 受理评估器（v1: 确定性规则 mock；P2 末换轻模型）。返回 accept 或 reject。 */
export type Assessor = (input: AssessInput) => { accept: true; mandate: string } | { accept: false; reason: string };

export interface OrchestratorOptions {
  readonly assessor: Assessor;
  /** ticket 计数器种子（id 生成）。 */
  readonly idSeed?: string;
}

export class Orchestrator {
  private readonly bus: BusLike;
  private readonly opts: OrchestratorOptions;
  readonly view: TicketView = newTicketView();
  /** 入口过滤管线（P3-d 接入：rule_gate → ambiguity，jcf 移植件）。 */
  readonly ruleGate: RuleGate;
  readonly ambiguity: AmbiguityRouter;
  private ticketCount = 0;
  /** thread → worker session id（订阅直通表）。 */
  private readonly subscriptions = new Map<string, string>();

  constructor(bus: BusLike, opts: OrchestratorOptions) {
    this.bus = bus;
    this.opts = opts;
    this.ruleGate = new RuleGate();
    this.ambiguity = new AmbiguityRouter();
  }

  /**
   * 入口过滤管线（jcf 移植件接线，docs/005 §3）：
   *   rule_gate（Fast Path）→ ambiguity 三路 → 受理评估（Slow Path）
   * GIBBERISH → intake.filtered{stage: rule_gate|ambiguity}；
   * HIGH → clarify（返回追问话术，不产事件——P5 接轻模型后产 reply.sent）；
   * LOW/PASS → 走 assessor 慢路径。
   *
   * 旁路（bypassAssess）：结构与上游一致——上游程序层（rule_gate/ambiguity）筛掉的
   * 是"不值得消耗模型"的；但 GitHub Issue/PR 这类结构化源自带强信号（已经是工单），
   * 跳过模糊度分流直接进受理评估（github_scout 语义：工单不该被当聊天过滤）。
   */
  intake(triggerId: EventId, text: string, structured: boolean = false): IntakeVerdict {
    const gate = this.ruleGate.evaluate(text);
    if (gate.action === 'BLOCK') {
      this.appendEvent('intake.filtered', 'router', { reason: `rule_gate:${gate.matchedRule}:${gate.reason}`, stage: 'rule_gate' }, triggerId);
      return { action: 'filtered', stage: 'rule_gate', reason: gate.reason };
    }
    let cleaned = gate.cleanedText;
    if (gate.action === 'TRUNCATE') cleaned = gate.cleanedText;
    if (!structured) {
      const route = this.ambiguity.route(cleaned);
      if (route.level === 'GIBBERISH') {
        this.appendEvent('intake.filtered', 'router', { reason: `ambiguity:${route.reason}`, stage: 'ambiguity' }, triggerId);
        return { action: 'filtered', stage: 'ambiguity', reason: route.reason };
      }
      if (route.level === 'HIGH') {
        const prompt = this.ambiguity.generateClarifyPrompt(cleaned, route);
        return { action: 'clarify', reason: route.reason, prompt };
      }
    }
    return { action: 'assess', cleaned };
  }

  /** 入口：一个 Trigger 到达 Router。产受理或拒绝事件；返回 ticketId 或 null。 */
  onTrigger(triggerSeq: number, triggerId: EventId, thread: string, kind: string, text: string, structured: boolean = false): string | null {
    // 直通检查：该 Thread 已有在办 Ticket → 不再评估，直接归属（002 §4 订阅直通）
    const existing = this.subscriptions.get(thread);
    if (existing !== undefined && this.view.byId.get(existing)?.status === 'working') {
      // 同 Thread 的后续消息归当前 Ticket；Worker 侧会作为 follow-up 收到（P2-d 接投递）
      this.appendReply(existing, 'ack', `已并入当前工作（${existing}）。`, triggerId, thread);
      return existing;
    }

    // 入口过滤管线（P3-d）：结构化源（GitHub）旁路模糊分流；BLOCK/GIBBERISH 过滤、HIGH 澄清不受理
    const intake = this.intake(triggerId, text, structured);
    if (intake.action === 'filtered') return null;
    if (intake.action === 'clarify') {
      this.appendEvent('intake.filtered', 'router', { reason: `clarify:${intake.reason}`, stage: 'ambiguity' }, triggerId);
      return null;
    }

    const verdict = this.opts.assessor({ triggerId, thread, kind, text: intake.cleaned, fromWorker: false });
    if (!verdict.accept) {
      this.appendEvent('intake.filtered', 'router', { reason: verdict.reason, stage: 'router_assess' }, triggerId);
      return null;
    }
    return this.openTicket(triggerId, thread, verdict.mandate);
  }

  /** 开 Ticket：opened + ack + dispatched 三事件原子序（顺序即语义）。 */
  openTicket(triggerId: EventId, thread: string, mandate: string): string {
    this.ticketCount++;
    const ticketId = `${this.opts.idSeed ?? 't'}-${String(this.ticketCount).padStart(4, '0')}`;
    const workerSessionId = `worker-${ticketId}`;
    this.appendEvent('ticket.opened', 'router', { ticketId, thread, mandate, workerSessionId, triggerId }, triggerId);
    this.appendReply(ticketId, 'ack', `已受理（${ticketId}）：${mandate}`, triggerId, thread);
    this.appendEvent('router.dispatched', 'router', { ticketId, workerSessionId }, `tkt_${ticketId}`);
    this.subscriptions.set(thread, ticketId);
    this.applyLocal(ticketId === undefined ? [] : this.recentFor(ticketId));
    return ticketId;
  }

  /** Worker 报告完成：ended + result 回复（Worker 的一切对外输出经 Router，002 §4）。 */
  workerDone(ticketId: string, outcome: 'delivered' | 'failed' | 'dropped', text: string, causedBy: EventId): void {
    const t = this.view.byId.get(ticketId);
    if (t === undefined) throw new Error(`[orchestrator] 未知 ticket: ${ticketId}`);
    const purpose = outcome === 'delivered' ? 'result' : 'attention';
    this.appendEvent('reply.sent', 'router', { ticketId, purpose, text, thread: t.thread }, causedBy);
    this.appendEvent('ticket.ended', 'router', { ticketId, outcome, by: 'worker' }, causedBy);
    if (this.subscriptions.get(t.thread) === ticketId) this.subscriptions.delete(t.thread);
    this.applyLocal([]);
  }

  /** 合并回复（直通路径的对外发言）。 */
  private appendReply(ticketId: string, purpose: 'ack' | 'result' | 'attention', text: string, causedBy: EventId, thread: string): void {
    this.appendEvent('reply.sent', 'router', { ticketId, purpose, text, thread }, causedBy);
  }

  private appendEvent(type: 'ticket.opened' | 'ticket.ended' | 'router.dispatched' | 'reply.sent' | 'intake.filtered', producer: string, payload: Record<string, unknown>, causedBy: EventId): { seq: number; id: EventId } {
    const id = `or_${type}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; // 运行时唯一性；重放按 seq
    const r = this.bus.append(this.bus.child(type, producer, payload, id, causedBy));
    if (r.kind !== 'stored') throw new Error(`[orchestrator] 事件追加失败: ${id} 与 ${r.kind === 'duplicate' ? r.canonicalId : '?'} 冲突`);
    applyTicketEvent(this.view, { seq: r.event.seq, type, payload });
    return { seq: r.event.seq, id: r.event.id };
  }

  /** 兜底视图同步（openTicket 用 recentFor 简化；全量重建由 rebuildTickets 覆盖）。 */
  private recentFor(_ticketId: string): Array<{ seq: number; type: string; payload: unknown }> {
    return [];
  }

  private applyLocal(_events: Array<{ seq: number; type: string; payload: unknown }>): void {
    // 事件已在 appendEvent 内逐条 apply；此处留作批量优化点。
  }
}

/** 从总线事件全量重建视图（启动/重放路径）。 */
export function orchestratorViewFrom(events: ReadonlyArray<{ seq: number; type: string; payload: unknown }>): TicketView {
  return rebuildTickets(events);
}
