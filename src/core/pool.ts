/**
 * Worker 池 —— 并发槽位调度（core，零 I/O；docs/002 §4、上游 WorkerSlots 模式的简化版）。
 *
 * 规则：
 *   - 槽位数上限（默认 4）；打满时新任务排队（FIFO）。
 *   - 槽位在 workerDone 时释放；释放时自动弹出队首。
 *   - 与上游一致：不在这里做优先级（信用槽位权重属 P5）。
 */
export interface PoolSlot {
  readonly ticketId: string;
  readonly sessionId: string;
}

export class WorkerPool {
  private readonly running = new Map<string, PoolSlot>(); // ticketId → slot
  private readonly queue: PoolSlot[] = [];
  private readonly listeners = new Set<(slot: PoolSlot) => void>();
  private readonly maxSlots: number;

  constructor(maxSlots: number = 4) {
    this.maxSlots = maxSlots;
  }

  /** 请求一个槽位；立即获得或排队。返回 true=已上槽，false=已排队。 */
  acquire(slot: PoolSlot): boolean {
    if (this.running.size < this.maxSlots) {
      this.running.set(slot.ticketId, slot);
      return true;
    }
    this.queue.push(slot);
    return false;
  }

  /** 释放槽位并弹队首。返回被弹出的槽位（调用方负责启动它）。 */
  release(ticketId: string): PoolSlot | null {
    if (!this.running.delete(ticketId)) return null;
    const next = this.queue.shift() ?? null;
    if (next !== null) this.running.set(next.ticketId, next);
    if (next !== null) for (const l of this.listeners) l(next);
    return next;
  }

  onSlotFreed(listener: (slot: PoolSlot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): { running: number; queued: number; maxSlots: number } {
    return { running: this.running.size, queued: this.queue.length, maxSlots: this.maxSlots };
  }

  runningTickets(): string[] {
    return [...this.running.keys()];
  }
}

/** 基准统计器 —— 四张表的数据收集（docs/006 §3：完成时间/成本/打扰率/漏放误杀）。 */
export interface TicketStat {
  ticketId: string;
  thread: string;
  /** 受理 seq（从 bus 回填）。 */
  acceptedSeq: number;
  deliveredSeq?: number | undefined;
  /** 打扰次数 = 对该 Ticket 发出的回复条数。 */
  interruptions: number;
  costUsd: number;
}

export class BenchmarkStats {
  private readonly byTicket = new Map<string, TicketStat>();

  recordAccepted(ticketId: string, thread: string, seq: number): void {
    this.byTicket.set(ticketId, { ticketId, thread, acceptedSeq: seq, interruptions: 0, costUsd: 0 });
  }

  recordDelivered(ticketId: string, seq: number, costUsd: number): void {
    const t = this.byTicket.get(ticketId);
    if (t === undefined) return;
    t.deliveredSeq = seq;
    t.costUsd = costUsd;
  }

  recordInterruption(ticketId: string): void {
    const t = this.byTicket.get(ticketId);
    if (t !== undefined) t.interruptions++;
  }

  /** 完成时间表（seq 差作时间代理；真实时钟由 meter 事件携带）。 */
  completionTimes(): Array<{ ticketId: string; deltaSeq: number }> {
    const out: Array<{ ticketId: string; deltaSeq: number }> = [];
    for (const t of this.byTicket.values()) {
      if (t.deliveredSeq !== undefined) out.push({ ticketId: t.ticketId, deltaSeq: t.deliveredSeq - t.acceptedSeq });
    }
    out.sort((a, b) => a.deltaSeq - b.deltaSeq);
    return out;
  }

  percentile(p: number): number | null {
    const arr = this.completionTimes();
    if (arr.length === 0) return null;
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
    return arr[idx]!.deltaSeq;
  }

  totals(): { tickets: number; delivered: number; interruptions: number; costUsd: number } {
    let delivered = 0;
    let interruptions = 0;
    let cost = 0;
    for (const t of this.byTicket.values()) {
      if (t.deliveredSeq !== undefined) delivered++;
      interruptions += t.interruptions;
      cost += t.costUsd;
    }
    return { tickets: this.byTicket.size, delivered, interruptions, costUsd: cost };
  }
}
