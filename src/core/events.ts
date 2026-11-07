/**
 * Shepherd 事件信封与类型命名空间 —— docs/005-event-sources.md §1 的 TS 直译。
 *
 * 三条铁律（005 §1）：
 * 1. 幂等  —— producer + 自然键去重；重复事实标记 duplicate，入库不入流。
 * 2. 因果  —— 每个事件必须填 causedBy（根事件显式声明为 null）；禁止症状事件。
 * 3. 全序  —— 消费按 seq 处理；同轮积压合并保留 seq 列表。
 *
 * 本文件属于 core/：零 I/O、零依赖（docs/910-conventions.md §2）。
 */

// ── 基础信封 ─────────────────────────────────────────────────────────

/** 全局唯一事件 id（ULID 风格；由 adapters 层生成，core 只约定形状） */
export type EventId = string;

/** 事件的真实来源标识。H-21 教训：指认生产者，不指认症状（docs/900-references.md）。 */
export type Producer = string;

/** HMAC-SHA256 链式审计哈希（"hmac:..."）；链头由 adapters/bus 维护。 */
export type AuditHash = string;

export interface EventEnvelope<T extends EventType = EventType, P = unknown> {
  /** 全序号：总线分配，单调递增。所有消费按 seq 处理。 */
  readonly seq: number;
  /** 幂等键（ULID）。 */
  readonly id: EventId;
  /** 事件类型（下方命名空间之一）。 */
  readonly type: T;
  /** 事件时间（生产者时钟）。 */
  readonly ts: string;
  /** 入总线时间。 */
  readonly ingestedAt: string;
  /** 真实生产者（"github:repo#42"、"session:ticket-17"、"watchdog"、"mock-gen"）。 */
  readonly producer: Producer;
  /** 因果父事件 id；根事件必须显式传 null。 */
  readonly causedBy: EventId | null;
  /** 载荷（按 type 收窄，见 EventOf 映射）。 */
  readonly payload: P;
  /** 链式审计哈希（入总线时由 adapters/bus 计算）。 */
  readonly auditHash?: AuditHash;
}

/** 重复到达的同一外部事实：入库（审计需要）但不进入消费流（005 §1 铁律 1）。 */
export interface DuplicateRecord {
  readonly canonicalId: EventId;
  readonly duplicateId: EventId;
  readonly naturalKey: string;
}

// ── 类型命名空间 ─────────────────────────────────────────────────────

export type EventType =
  // 源与入口过滤
  | 'source.trigger.received'
  | 'intake.accepted'
  | 'intake.filtered'
  // Ticket 生命周期
  | 'ticket.opened'
  | 'ticket.resumed'
  | 'ticket.ended'
  | 'ticket.subscribed'
  | 'ticket.unsubscribed'
  // Router
  | 'router.dispatched'
  | 'reply.sent'
  // 会话
  | 'session.started'
  | 'session.ended'
  | 'session.restarted'
  | 'session.turn.started'
  | 'session.turn.ended'
  // 异步工具（内核）
  | 'tool.started'
  | 'tool.result'
  | 'tool.cancelled'
  // HooH 出口裁决
  | 'hooh.decided'
  // 看门狗
  | 'watchdog.observed'
  | 'watchdog.intervened'
  | 'watchdog.escalated'
  // 信用与诱饵
  | 'credit.changed'
  | 'bait.planted'
  | 'bait.verified'
  | 'bait.missed'
  // 投机执行
  | 'speculation.proposed'
  | 'speculation.started'
  | 'speculation.delivered'
  | 'speculation.dropped'
  // 成本护栏
  | 'meter.charge'
  | 'meter.tripped'
  // 非确定性记录（回放用，002 §2）
  | 'clock.tick'
  | 'llm.request'
  | 'llm.response';

// ── 载荷形状（v1 最小集；字段只增不改，删字段走新类型） ───────────────

export interface TriggerPayload {
  /** 源内自然键，幂等去重的依据（如 "gh:repo#42:comment:1234"）。 */
  readonly naturalKey: string;
  readonly thread: string;
  readonly kind: 'comment' | 'ci' | 'issue' | 'mock';
  /** 大内容不进事件：blob 引用 + 哈希（005 §5）。 */
  readonly textRef?: { readonly blobRef: string; readonly size: number; readonly sha256: string };
  readonly url?: string;
}

export interface FilteredPayload {
  readonly reason: string;
  /** 哪一层滤的：rule_gate | ambiguity | credit | router_assess。 */
  readonly stage: 'rule_gate' | 'ambiguity' | 'credit' | 'router_assess';
}

export interface WatchdogObservedPayload {
  readonly sessionId: string;
  /** 结构化遥测（003 §2）；皮层输入只有这个，永不收自由文本（ADR-002）。 */
  readonly signals: TelemetrySignals;
  readonly cortex?: { readonly verdict: 'healthy' | 'drifting' | 'spinning'; readonly evidence: string };
}

export interface TelemetrySignals {
  readonly reportGapMs: number;
  readonly sameErrorStreak: number;
  readonly fileEditRepeat: number;
  readonly tokenSlope: number;
  readonly hoohDenyStreak: number;
  readonly turnNoToolStreak: number;
  readonly handleOrphans: number;
}

export interface WatchdogIntervenedPayload {
  readonly sessionId: string;
  readonly level: 'observe' | 'nudge' | 'restart' | 'escalate';
  /** 脊髓命中规则 id 列表或皮层判断 —— 介入必须带证据（003 §1 不变式 4）。 */
  readonly evidence: readonly string[];
  readonly angerAfter: number;
}

export interface CreditChangedPayload {
  readonly entity: string;
  readonly delta: number;
  readonly curAfter: number;
  readonly baseAfter: number;
}

export interface HoohDecidedPayload {
  readonly sessionId: string;
  readonly tool: string;
  readonly decision: 'allow' | 'deny' | 'sandboxed' | 'asked';
  readonly reason?: string;
}

export interface MeterChargePayload {
  readonly sessionId: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface ToolStartedPayload {
  readonly handle: string;
  readonly tool: string;
  /** 乐观执行标记（ADR-003）：只读白名单可抢跑。 */
  readonly optimistic: boolean;
}

export interface TicketOpenedPayload {
  readonly ticketId: string;
  readonly thread: string;
  readonly mandate: string;
  readonly workerSessionId: string;
  readonly triggerId: EventId;
}

export interface TicketEndedPayload {
  readonly ticketId: string;
  readonly outcome: 'delivered' | 'failed' | 'dropped';
  readonly by: string;
  readonly reason?: string;
}

export interface ReplySentPayload {
  readonly ticketId: string;
  readonly purpose: 'ack' | 'result' | 'attention';
  readonly text: string;
  readonly thread: string;
}

export interface AssessmentOutcomePayload {
  readonly decision: 'accept' | 'reject';
  readonly reason?: string;
  readonly triggerId: EventId;
}

// ── 按类型取载荷的映射（部分列出，P1 实现时补全） ─────────────────────

export interface EventOfMap {
  'source.trigger.received': TriggerPayload;
  'intake.filtered': FilteredPayload;
  'watchdog.observed': WatchdogObservedPayload;
  'watchdog.intervened': WatchdogIntervenedPayload;
  'credit.changed': CreditChangedPayload;
  'hooh.decided': HoohDecidedPayload;
  'meter.charge': MeterChargePayload;
  'tool.started': ToolStartedPayload;
  'ticket.opened': TicketOpenedPayload;
  'ticket.ended': TicketEndedPayload;
  'reply.sent': ReplySentPayload;
}

export type EventOf<T extends EventType> = T extends keyof EventOfMap
  ? EventEnvelope<T, EventOfMap[T]>
  : EventEnvelope<T, unknown>;

/** 事件信封的构造输入（auditHash 与 seq 由总线分配，调用方不填）。 */
export type EventDraft<T extends EventType = EventType> = Omit<
  EventEnvelope<T>,
  'seq' | 'auditHash'
> & { readonly auditHash?: never };
