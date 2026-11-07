/**
 * Watchdog 独立进程入口（apps/watchdog）—— docs/003 §1 独立性不变式的落地点。
 *
 * 进程职责：
 *   1. 独立打开总线（只追加读 + 介入事件写）；
 *   2. 每 60s 一轮：从总线拉遥测快照（watchdog.observed 由 core 侧投喂或本进程
 *      从事件推导）→ WatchdogCore.observe → 介入事件入总线；
 *   3. 心跳：watchdog.heartbeat 事件（003 §6 看住看门狗：主系统发现 >5min 缺失告警）。
 *
 * v1 简化：遥测由 core 侧的 TelemetryCollector 产生、经总线投递（事件溯源：
 * watchdog 进程崩溃重启后从总线重放信号窗口）。
 */
import { SqliteBus } from '../adapters/store.ts';
import { WatchdogCore } from '../core/watchdog/core.ts';
import { TelemetryCollector } from '../core/watchdog/telemetry.ts';
import type { InterventionLevel } from '../core/watchdog/anger.ts';

export interface WatchdogProcOptions {
  readonly dbPath: string;
  readonly auditKey: string;
  /** 每轮轮询间隔（默认 60s）。 */
  readonly intervalMs?: number;
  /** 心跳间隔（默认 60s——主系统 >5min 缺失告警）。 */
  readonly heartbeatMs?: number;
  /** 信用查询（v1: 全部默认 80；P5 接信用视图）。 */
  readonly creditOf?: (sessionId: string) => number;
}

export class WatchdogProcess {
  private readonly bus: SqliteBus;
  private readonly core: WatchdogCore;
  private readonly collectors = new Map<string, TelemetryCollector>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly interval: number;
  private readonly heartbeat: number;
  private readonly creditOf: (sessionId: string) => number;
  private running = false;

  constructor(opts: WatchdogProcOptions) {
    this.bus = new SqliteBus(opts.dbPath, opts.auditKey);
    this.interval = opts.intervalMs ?? 60_000;
    this.heartbeat = opts.heartbeatMs ?? 60_000;
    this.creditOf = opts.creditOf ?? (() => 80);
    this.core = new WatchdogCore({
      nowMs: Date.now(),
      executor: {
        execute: async (sessionId, level, evidence) => {
          this.emitIntervention(sessionId, level, evidence, this.core.anger.current());
        },
      },
    });
  }

  /** 投喂一批遥测（apps/host 层从会话收集后调用；事件入总线供重放）。 */
  feedSignals(sessionId: string, signals: import('../core/events.ts').TelemetrySignals, nowMs: number): void {
    let collector = this.collectors.get(sessionId);
    if (collector === undefined) {
      collector = new TelemetryCollector(nowMs);
      this.collectors.set(sessionId, collector);
    }
    this.bus.append(
      this.bus.child('watchdog.observed', 'watchdog', { sessionId, signals, ts: nowMs }, `wd_obs_${sessionId}_${nowMs}`, 'wd_root'),
    );
  }

  /** 单轮观察（apps 层驱动或定时器）。返回介入决策（测试用）。 */
  async observeOnce(sessionId: string, nowMs: number): Promise<{ level: InterventionLevel; evidence: ReadonlyArray<{ field: string; value: unknown }>; angerAfter: number } | null> {
    const collector = this.collectors.get(sessionId);
    if (collector === undefined) return null;
    const signals = collector.current();
    const credit = this.creditOf(sessionId);
    const decision = await this.core.observe({ sessionId, signals, credit, nowMs });
    return decision === null ? null : { level: decision.level, evidence: decision.evidence, angerAfter: decision.angerAfter };
  }

  private emitIntervention(sessionId: string, level: InterventionLevel, evidence: ReadonlyArray<{ field: string; value: unknown }>, angerAfter: number): void {
    this.bus.append(
      this.bus.child('watchdog.intervened', 'watchdog', { sessionId, level, evidence, angerAfter }, `wd_int_${sessionId}_${Date.now()}`, 'wd_root'),
    );
  }

  /** 启动定时轮询 + 心跳。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      for (const sessionId of this.collectors.keys()) {
        void this.observeOnce(sessionId, Date.now()).catch(() => {});
      }
    }, this.interval);
    this.heartbeatTimer = setInterval(() => {
      this.bus.append(this.bus.child('meter.charge', 'watchdog-heartbeat', { alive: true }, `wd_hb_${Date.now()}`, 'wd_root'));
    }, this.heartbeat);
    // 首个心跳立即发
    this.bus.append(this.bus.child('meter.charge', 'watchdog-heartbeat', { alive: true }, `wd_hb_${Date.now()}`, 'wd_root'));
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.running = false;
    this.bus.close();
  }

  /** 看住看门狗：心跳是否健康（003 §6：主系统侧调用）。 */
  static heartbeatHealthy(events: ReadonlyArray<{ type: string; ts: string }>, nowMs: number, maxGapMs: number = 5 * 60_000): boolean {
    const heartbeats = events.filter(e => e.type === 'meter.charge').filter(e => (e as unknown as { payload?: { alive?: boolean } }).payload?.alive === true);
    if (heartbeats.length === 0) return false;
    const last = heartbeats[heartbeats.length - 1]!;
    return nowMs - new Date(last.ts).getTime() <= maxGapMs;
  }
}
