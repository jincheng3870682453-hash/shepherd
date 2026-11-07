/**
 * 会话运行器（apps/runtime 的核心齿轮；P1 以库形态存在并直接测全链路，P2 进 runtime 进程）。
 *
 * 职责：把"总线 + 会话内核 + 模型客户端 + 执行器"接成一个可驱动的循环：
 *   启动轮：模型产出 → tool.started 事件 → 发起执行（不 await，异步语义）
 *   完成：  tool.result/tool.cancelled 事件入总线 → 投递给会话（步间注入）
 *   驱动轮：takeBatch 注入 → 模型 → 落账 → 归档检查
 *
 * 事件 id 规则：以 handle 推导（ts_/tr_/tc_ 前缀）；同一 handle 的迟到结果不再重复写
 * result 事件，而是写 superseded 标记（002 §3：事实不丢弃）。执行器回调与显式调用竞态
 * 由"已裁决即拒绝写 result"挡住。
 */
import type { ModelClient, TurnRequest } from '../adapters/llm.ts';
import type { SessionHost } from '../core/session.ts';
import { Session } from '../core/session.ts';
import type { EventDraft, EventId, EventType } from '../core/events.ts';

/** 运行器对总线的最小依赖（SqliteBus 满足此形状）。 */
export interface BusLike {
  append(draft: EventDraft, naturalKey?: string): { kind: 'stored'; event: { seq: number; id: EventId } } | { kind: 'duplicate'; canonicalId: EventId; naturalKey: string };
  root<T extends EventType>(type: T, producer: string, payload: unknown, id: EventId): EventDraft<T>;
  child<T extends EventType>(type: T, producer: string, payload: unknown, id: EventId, causedBy: EventId): EventDraft<T>;
}

export interface RunnerOptions {
  readonly sessionId: string;
  readonly model: string;
  readonly optimisticWhitelist: readonly string[];
  /** 真实工具执行器：handle → 执行；P1 测试里是假执行器，P3 接 HooH-MCP。 */
  readonly executor: (tool: string, args: unknown, handle: EventId) => Promise<unknown>;
}

export class SessionRunner implements SessionHost {
  readonly session: Session;
  private readonly bus: BusLike;
  private readonly modelClient: ModelClient;
  private readonly opts: RunnerOptions;
  private turnIndex = 0;
  /** 已写总线的结果/取消事件句柄集合（防同 handle 重复写同 id 事件）。 */
  private readonly settled = new Set<EventId>();
  /** 执行器回调投递的迟到结果（写入 superseded 事件，事实不丢弃）。 */
  private readonly lateResults = new Set<EventId>();

  constructor(bus: BusLike, modelClient: ModelClient, opts: RunnerOptions) {
    this.bus = bus;
    this.modelClient = modelClient;
    this.opts = opts;
    this.session = new Session(opts.sessionId, this);
  }

  // ── SessionHost 端口 ──────────────────────────────────────────────

  isOptimisticAllowed(tool: string): boolean {
    return this.opts.optimisticWhitelist.includes(tool);
  }

  stopHandle(handle: EventId): void {
    // 内核主动 stop：进入下一轮的 stop 队列（在 drive 中统一落事件）。
    this.cancelHandle(handle, `session:${this.opts.sessionId}`);
  }

  // ── 事件 id ───────────────────────────────────────────────────────

  private freshId(base: string): EventId {
    let id = base;
    let n = 1;
    // 已结算集合 + 兜底查重：id 只增不撞
    while (this.settled.has(id)) {
      id = `${base}#${n++}`;
    }
    return id;
  }

  // ── 驱动 ──────────────────────────────────────────────────────────

  /** 启动轮：模型产出首个决策；每个 start 一个 tool.started 事件 + 发起执行。 */
  async start(triggerEventId: EventId): Promise<void> {
    const req: TurnRequest = { sessionId: this.opts.sessionId, turnIndex: this.turnIndex, messages: [], model: this.opts.model };
    const out = await this.modelClient.turn(req);
    for (const t of out.toolStarts ?? []) {
      const before = this.session.handles.size;
      this.session.applyTurn(this.turnIndex, { toolStarts: [t] });
      const rec = [...this.session.handles.values()][before];
      if (rec === undefined) continue;
      const id = this.freshId(`ts_${rec.handle}`);
      this.settled.add(id);
      const ev = this.bus.child(
        'tool.started',
        `session:${this.opts.sessionId}`,
        { handle: rec.handle, tool: t.tool, args: t.args, optimistic: rec.optimistic },
        id,
        triggerEventId,
      );
      this.bus.append(ev);
      // 异步语义：发起执行但不 await。回调到达时若已裁决，由 completeHandle 拒绝。
      void this.opts.executor(t.tool, t.args, rec.handle)
        .then(result => this.completeHandle(rec.handle, result))
        .catch((err: unknown) => this.completeHandle(rec.handle, { error: String(err) }));
    }
    for (const s of out.toolStops ?? []) {
      this.session.applyTurn(this.turnIndex, { toolStops: [s] });
    }
    this.turnIndex++;
  }

  /** 工具完成：结果事件入总线（真实世界 → 总线的入口）。结算由 takeBatch 按 seq 裁决。 */
  completeHandle(handle: EventId, result: unknown): void {
    const rec = this.session.handles.get(handle);
    if (rec === undefined) return;
    if (rec.state !== 'running') {
      // 句柄已被上一批结算（resolved/cancelled/superseded）：迟到结果标 superseded 入库，不投递
      if (!this.lateResults.has(handle)) {
        this.lateResults.add(handle);
        const id = this.freshId(`tr_${handle}`);
        this.settled.add(id);
        const ev = this.bus.child('tool.result', `executor:${rec.tool}`, { handle, result, superseded: true }, id, `ts_${handle}`);
        this.bus.append(ev);
      }
      return;
    }
    const id = this.freshId(`tr_${handle}`);
    this.settled.add(id);
    const ev = this.bus.child('tool.result', `executor:${rec.tool}`, { handle, result }, id, `ts_${handle}`);
    const appended = this.bus.append(ev);
    if (appended.kind === 'stored') {
      this.session.deliver(appended.event.seq, 'tool.result', handle, result, appended.event.id);
    }
  }

  /** 取消事件入总线（模型 stop、看门狗、人触发的统一入口）。已决句柄幂等跳过。
   *  注意：不在此时改句柄状态 —— 结算统一发生在 takeBatch 按 seq 裁决（002 §3 先到算数）。 */
  cancelHandle(handle: EventId, by: string): void {
    const rec = this.session.handles.get(handle);
    if (rec === undefined || rec.state !== 'running') return;
    const id = this.freshId(`tc_${handle}`);
    this.settled.add(id);
    const ev = this.bus.child('tool.cancelled', by, { handle }, id, `ts_${handle}`);
    const appended = this.bus.append(ev);
    if (appended.kind === 'stored') {
      this.session.deliver(appended.event.seq, 'tool.cancelled', handle, undefined, appended.event.id);
    }
  }

  /**
   * 驱动轮：注入积压 → 模型 → 落账 → 新 start 事件 → 归档检查。
   * 返回本轮模型是否产出新工具启动（false = 会话收敛）。
   */
  async drive(): Promise<boolean> {
    const { injected, superseded } = this.session.takeBatch();
    // 迟到裁决落回总线（事实不丢弃，002 §3）：同 handle 只记一次
    for (const ev of superseded) {
      if (ev.handle === undefined || this.lateResults.has(ev.handle)) continue;
      this.lateResults.add(ev.handle);
      const rec = this.session.handles.get(ev.handle);
      if (rec === undefined) continue;
      const id = this.freshId(`tr_${ev.handle}`);
      this.settled.add(id);
      const mark = this.bus.child(
        'tool.result',
        `executor:${rec.tool}`,
        { handle: ev.handle, superseded: true, supersededBy: ev.kind, result: ev.payload },
        id,
        `ts_${ev.handle}`,
      );
      this.bus.append(mark);
    }
    if (injected.length === 0 && this.session.runningHandles() > 0) return false;
    const req: TurnRequest = { sessionId: this.opts.sessionId, turnIndex: this.turnIndex, messages: this.session.context, model: this.opts.model };
    const out = await this.modelClient.turn(req);
    let anyStart = false;
    for (const s of out.toolStops ?? []) {
      this.cancelHandle(s.handle, `session:${this.opts.sessionId}`);
    }
    for (const t of out.toolStarts ?? []) {
      const before = this.session.handles.size;
      this.session.applyTurn(this.turnIndex, { toolStarts: [t] });
      const rec = [...this.session.handles.values()][before];
      if (rec === undefined) continue;
      const id = this.freshId(`ts_${rec.handle}`);
      this.settled.add(id);
      const ev = this.bus.child(
        'tool.started',
        `session:${this.opts.sessionId}`,
        { handle: rec.handle, tool: t.tool, args: t.args, optimistic: rec.optimistic },
        id,
        `ts_${this.opts.sessionId}`,
      );
      this.bus.append(ev);
      void this.opts.executor(t.tool, t.args, rec.handle)
        .then(result => this.completeHandle(rec.handle, result))
        .catch((err: unknown) => this.completeHandle(rec.handle, { error: String(err) }));
      anyStart = true;
    }
    this.session.archiveResolved(rec => `${rec.tool}(${rec.handle})→${rec.state}`);
    this.turnIndex++;
    return anyStart;
  }
}
