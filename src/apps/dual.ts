/**
 * P2-e：双层整合运行时 —— 把 Orchestrator、WorkerPool、SessionRunner 接成一个
 * 可并发驱动的系统（apps 层；docs/007 P2-e、docs/002 §4）。
 *
 * 驱动模型：
 *   feed(trigger...) → Orchestrator 受理 → acquire 槽位 → SessionRunner.start
 *   → 完成回调 → Orchestrator.workerDone → release → 自动弹队首启动
 * 全部产物走总线；统计从总线事件推导。
 */
import type { BusLike } from '../apps/runner.ts';
import { SessionRunner } from '../apps/runner.ts';
import type { ModelClient, TurnRecord } from '../adapters/llm.ts';
import { Orchestrator, type Assessor } from '../core/orchestrator.ts';
import { WorkerPool, BenchmarkStats } from '../core/pool.ts';

export interface DualLayerOptions {
  readonly assessor: Assessor;
  readonly maxWorkers: number;
  readonly optimisticWhitelist: readonly string[];
  /** 每会话的模型（按 sessionId 寻址；测试用 ReplayModel，生产用 RecordingModel(DeepSeekModel)）。 */
  readonly model: ModelClient;
  readonly executor: (tool: string, args: unknown, handle: string) => Promise<unknown>;
}

interface ActiveWorker {
  readonly ticketId: string;
  readonly runner: SessionRunner;
  readonly executor: ControlledLike;
}

interface ControlledLike {
  executed: ReadonlyArray<{ tool: string; handle: string }>;
  complete(handle: string, value: unknown): void;
}

export class DualLayerRuntime {
  readonly orchestrator: Orchestrator;
  readonly pool: WorkerPool;
  readonly stats = new BenchmarkStats();
  private readonly bus: BusLike;
  private readonly opts: DualLayerOptions;
  private readonly active = new Map<string, ActiveWorker>();
  private readonly pendingModels: Array<{ sid: string; triggerId: string; ticketId: string }> = [];
  private readonly completed: string[] = [];

  constructor(bus: BusLike, opts: DualLayerOptions) {
    this.bus = bus;
    this.opts = opts;
    this.orchestrator = new Orchestrator(bus, { assessor: opts.assessor });
    this.pool = new WorkerPool(opts.maxWorkers);
    this.pool.onSlotFreed(slot => void this.launchPending());
  }

  /** 喂入一个已入库 Trigger。受理 → 排队/上槽。 */
  feed(triggerSeq: number, triggerId: string, thread: string, kind: string, text: string): string | null {
    const ticketId = this.orchestrator.onTrigger(triggerSeq, triggerId, thread, kind, text);
    if (ticketId === null) return null;
    this.stats.recordAccepted(ticketId, thread, triggerSeq);
    const sid = this.orchestrator.view.byId.get(ticketId)!.workerSessionId;
    const acquired = this.pool.acquire({ ticketId, sessionId: sid });
    if (acquired) {
      void this.launch(ticketId, sid, triggerId);
    } else {
      this.pendingModels.push({ sid, triggerId, ticketId });
    }
    return ticketId;
  }

  private async launchPending(): Promise<void> {
    const next = this.pendingModels.shift();
    if (next !== undefined) {
      await this.launch(next.ticketId, next.sid, next.triggerId);
    }
  }

  private async launch(ticketId: string, sid: string, triggerId: string): Promise<void> {
    const executor = new ControlledExecutor(this.opts.executor);
    const runner = new SessionRunner(this.bus, this.opts.model, {
      sessionId: sid,
      model: 'mock',
      optimisticWhitelist: this.opts.optimisticWhitelist,
      executor: executor.run,
    });
    this.active.set(ticketId, { ticketId, runner, executor });
    await runner.start(triggerId);
  }

  /** Worker 侧完成：结算执行器 → 驱动 → workerDone → 释放槽位。 */
  async completeWorker(ticketId: string): Promise<void> {
    const w = this.active.get(ticketId);
    if (w === undefined) throw new Error(`[dual] 未在跑的 worker: ${ticketId}`);
    for (const { handle } of w.executor.executed) {
      w.executor.complete(handle, { ok: true });
    }
    await w.runner.drive();
    // 完成事件（seq 从 worker 的最后一个 result 事件近似；统计用）
    const allSeq = this.bus.append(this.bus.child('meter.charge', 'stats', { ticketId, costUsd: 0.01 }, `st_${ticketId}`, `tkt_${ticketId}`));
    if (allSeq.kind === 'stored') {
      this.stats.recordDelivered(ticketId, allSeq.event.seq, 0.01);
    }
    this.orchestrator.workerDone(ticketId, 'delivered', `任务完成（${ticketId}）`, `tkt_${ticketId}`);
    this.completed.push(ticketId);
    this.active.delete(ticketId);
    this.pool.release(ticketId);
  }

  /** 当前是否全部收敛（无 running、无 queued）。 */
  settled(): boolean {
    return this.pool.stats().running === 0 && this.pool.stats().queued === 0 && this.pendingModels.length === 0;
  }

  completedTickets(): string[] {
    return [...this.completed];
  }
}

class ControlledExecutor {
  private readonly deferred = new Map<string, { resolve: (v: unknown) => void }>();
  private readonly impl: (tool: string, args: unknown, handle: string) => Promise<unknown>;
  readonly executed: Array<{ tool: string; handle: string }> = [];
  constructor(impl: (tool: string, args: unknown, handle: string) => Promise<unknown>) {
    this.impl = impl;
    void this.impl;
  }
  readonly run = (tool: string, _args: unknown, handle: string): Promise<unknown> => {
    this.executed.push({ tool, handle });
    return new Promise(resolve => {
      this.deferred.set(handle, { resolve });
    });
  };
  complete(handle: string, value: unknown): void {
    const d = this.deferred.get(handle);
    if (d !== undefined) {
      this.deferred.delete(handle);
      d.resolve(value);
    }
  }
}
