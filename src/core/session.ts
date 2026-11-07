/**
 * 异步会话内核（docs/002 §3）—— 事件驱动的 ReAct 状态机，纯逻辑零 I/O。
 *
 * 模型调用与工具执行由 Host 端口注入；内核只管状态机与注入语义：
 *   一轮 = 取一批事件 → 一次 LLM 调用 → 执行工具（可 start 异步）→ 产出新事件
 *   步间注入：tool.result 只在该会话"取下一批事件"时合并进上下文，永不打断生成。
 *   取消竞态：stop(handle) 与 tool.result 竞争时先到总线的算数（按 seq），后到标 superseded。
 *   孤儿清理：会话结束/重启时未决句柄进宽限期，到点 tool.cancelled。
 *
 * 乐观执行（ADR-003）在此表现为：模型可以在句柄未决时继续下一轮（内核不阻塞），
 * 是否乐观由工具白名单决定（Host 校验），口吃回合 = 修正事件，不计熔断。
 */
import type { EventId } from './events.ts';

export type HandleState = 'running' | 'result_pending' | 'resolved' | 'cancelled' | 'superseded';

export interface HandleRecord {
  readonly handle: EventId;
  readonly tool: string;
  readonly optimistic: boolean;
  readonly startedSeq: number;
  state: HandleState;
  /** resolved/cancelled/superseded 时的裁决 seq（竞态判定依据）。 */
  readonly settledSeq?: number;
}

/** Host 注入的模型应答（模拟与真实 LLM 共用此形状）。 */
export interface TurnOutput {
  text?: string | undefined;
  toolStarts?: ReadonlyArray<{ readonly tool: string; readonly args: unknown; readonly optimistic: boolean }> | undefined;
  toolStops?: ReadonlyArray<{ readonly handle: EventId; readonly reason?: string }> | undefined;
}

export interface PendingEvent {
  readonly seq: number;
  readonly kind: 'tool.result' | 'tool.cancelled' | 'injected';
  readonly handle?: EventId | undefined;
  readonly payload: unknown;
  /** 该事件在总线上的 id（因果链回填用；adapters 层投递时携带）。 */
  readonly eventId?: EventId | undefined;
}

export interface SessionHost {
  /** 该工具是否允许乐观执行（ADR-003 白名单；Host 校验，内核不持有白名单）。 */
  isOptimisticAllowed(tool: string): boolean;
  /** 结束句柄（真实执行层在 adapters；内核只记账）。返回是否还有未决句柄。 */
  stopHandle(handle: EventId): void;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_results' | 'archived';

/** 会话内筹码：一条事实 = 一行摘要 + 引用（归档后原文在总线）。 */
export interface ArchiveEntry {
  readonly handle: EventId;
  readonly summary: string;
  readonly resultSeq: number;
}

export interface SessionState {
  readonly sessionId: string;
  status: SessionStatus;
  cursorSeq: number;
  handles: Map<EventId, HandleRecord>;
  pending: PendingEvent[];
  archive: ArchiveEntry[];
  /** 跨轮上下文（会话记忆）；由 Host 在每轮组装。 */
  readonly context: unknown[];
}

/**
 * 会话状态机的纯语义。时间与执行全部经 Host 注入，单测无需 mock 时钟。
 */
export class Session {
  private readonly host: SessionHost;
  readonly id: string;
  status: SessionStatus = 'idle';
  cursorSeq = 0;
  readonly handles = new Map<EventId, HandleRecord>();
  readonly pending: PendingEvent[] = [];
  readonly archive: ArchiveEntry[] = [];
  readonly context: unknown[] = [];

  constructor(id: string, host: SessionHost) {
    this.id = id;
    this.host = host;
  }

  /** 步间注入：结果事件进入待合并队列（P1 中由外部在事件到达时调用）。 */
  deliver(seq: number, kind: PendingEvent['kind'], handle: EventId | undefined, payload: unknown, eventId?: EventId): void {
    this.pending.push({ seq, kind, handle, payload, eventId });
    this.pending.sort((a, b) => a.seq - b.seq);
    if (this.status === 'idle') this.status = 'awaiting_results';
  }

  /**
   * 开始一轮：合并 pending（按 seq 序）进上下文并裁决竞态，返回本轮的事件批次。
   * 竞态规则：tool.result 与 tool.cancelled 先到（seq 小）的算数，后到的标 superseded。
   */
  takeBatch(): { readonly injected: PendingEvent[]; readonly superseded: PendingEvent[] } {
    const injected: PendingEvent[] = [];
    const superseded: PendingEvent[] = [];
    for (const ev of this.pending) {
      if (ev.handle !== undefined) {
        const rec = this.handles.get(ev.handle);
        if (rec !== undefined) {
          if (rec.state === 'resolved' || rec.state === 'cancelled' || rec.state === 'superseded') {
            // 已有更早的裁决：本事件为迟到者
            superseded.push(ev);
            continue;
          }
          if (ev.kind === 'tool.result') {
            rec.state = 'resolved';
            this.context.push({ kind: 'tool.result', handle: ev.handle, payload: ev.payload });
          } else if (ev.kind === 'tool.cancelled') {
            rec.state = 'cancelled';
            this.context.push({ kind: 'tool.cancelled', handle: ev.handle });
          }
          injected.push(ev);
          continue;
        }
      }
      // 无句柄关联的注入（如 watchdog nudge）
      this.context.push({ kind: ev.kind, payload: ev.payload });
      injected.push(ev);
    }
    this.pending.length = 0;
    if (injected.length > 0) this.cursorSeq = injected[injected.length - 1]!.seq;
    if (this.runningHandles() === 0 && this.status === 'running') this.status = 'idle';
    return { injected, superseded };
  }

  /** 模型输出落账：start 记句柄（乐观标记由 Host 白名单复核），stop 取消。 */
  applyTurn(seq: number, output: TurnOutput): void {
    for (const s of output.toolStops ?? []) {
      const rec = this.handles.get(s.handle);
      if (rec !== undefined && rec.state === 'running') {
        rec.state = 'cancelled';
        this.host.stopHandle(s.handle);
      }
    }
    for (const t of output.toolStarts ?? []) {
      const optimistic = t.optimistic && this.host.isOptimisticAllowed(t.tool);
      const handle = `h_${this.id}_${seq}_${this.handles.size}`;
      this.handles.set(handle, {
        handle,
        tool: t.tool,
        optimistic,
        startedSeq: seq,
        state: 'running',
      });
      this.status = 'running';
    }
    // 无新启动且（启动被抵消后）无运行中句柄 → 回到 idle
    if ((output.toolStarts?.length ?? 0) === 0 && this.runningHandles() === 0) {
      this.status = 'idle';
    }
  }

  /** 归档：已决句柄的启动过程压成一行摘要（原文在总线）。 */
  archiveResolved(summarize: (rec: HandleRecord) => string): number {
    let n = 0;
    for (const rec of this.handles.values()) {
      if (rec.state === 'resolved' || rec.state === 'cancelled') {
        this.archive.push({ handle: rec.handle, summary: summarize(rec), resultSeq: rec.startedSeq });
        n++;
      }
    }
    if (n > 0 && this.runningHandles() === 0) this.status = 'idle';
    return n;
  }

  runningHandles(): number {
    let n = 0;
    for (const rec of this.handles.values()) if (rec.state === 'running') n++;
    return n;
  }

  /** 孤儿清理：会话结束/重启时未决句柄（Host 负责真实 kill；内核记账 + 宽限期由事件驱动）。 */
  orphanHandles(): HandleRecord[] {
    const orphans: HandleRecord[] = [];
    for (const rec of this.handles.values()) {
      if (rec.state === 'running') {
        rec.state = 'cancelled';
        this.host.stopHandle(rec.handle);
        orphans.push(rec);
      }
    }
    return orphans;
  }
}
