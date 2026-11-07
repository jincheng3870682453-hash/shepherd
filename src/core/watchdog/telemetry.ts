/**
 * 遥测采集（core/watchdog/telemetry.ts）—— 从会话内核事件推导七信号（docs/003 §2）。
 *
 * 设计：TelemetryCollector 是纯函数状态机（零 I/O），输入=内核会话的观察切片
 * （adapters/apps 层投喂），输出=TelemetrySignals。实质进展定义继承 HooH STALL 规则：
 * 读类操作不算进展——只统计写类工具与工具结果变化。
 */
import type { TelemetrySignals } from '../events.ts';

/** 内核投喂的观察切片（apps 层从 Session 状态与总线事件取）。 */
export interface TelemetryObservation {
  readonly nowMs: number;
  /** 本轮发生的工具调用与结果（tool=工具名，ok=是否成功，writes=是否写类）。 */
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly ok: boolean; readonly writes: boolean }>;
  /** 本轮编辑过的文件路径（写类）。 */
  readonly editedFiles: ReadonlyArray<string>;
  /** 本轮 LLM token 消耗。 */
  readonly tokensUsed: number;
  /** 当前未决句柄数。 */
  readonly handleOrphans: number;
}

/** 错误指纹（同错判定：工具名+错误前缀哈希——内联实现，core 零依赖）。 */
function errorFingerprint(tool: string, ok: boolean): string {
  return ok ? '' : `${tool}:error`;
}

export class TelemetryCollector {
  private readonly windowMs: number;
  private lastSubstantiveMs: number;
  private lastErrorFingerprint = '';
  private errorStreak = 0;
  private readonly editCounts = new Map<string, number>();
  private tokenHistory: Array<{ ms: number; tokens: number }> = [];
  private lastSignals: TelemetrySignals;

  constructor(nowMs: number, windowMs: number = 30 * 60_000) {
    this.windowMs = windowMs;
    this.lastSubstantiveMs = nowMs;
    this.lastSignals = {
      reportGapMs: 0, sameErrorStreak: 0, fileEditRepeat: 0, tokenSlope: 0,
      hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0,
    };
  }

  /** 观察一轮：更新状态并产出当前信号快照。 */
  observe(obs: TelemetryObservation, hoohDenyStreak: number): TelemetrySignals {
    // 1. 实质报告间隔：写类工具成功才算实质（HooH STALL 规则：读类不算）
    const substantive = obs.tools.some(t => t.writes && t.ok);
    if (substantive) this.lastSubstantiveMs = obs.nowMs;

    // 2. 连续相同错误
    for (const t of obs.tools) {
      const fp = errorFingerprint(t.tool, t.ok);
      if (fp === '') continue;
      if (fp === this.lastErrorFingerprint) this.errorStreak++;
      else {
        this.lastErrorFingerprint = fp;
        this.errorStreak = 1;
      }
    }

    // 3. 同文件往返编辑（A→B→A 计 2：用编辑次数近似——同文件第 N 次编辑）
    for (const f of obs.editedFiles) {
      this.editCounts.set(f, (this.editCounts.get(f) ?? 0) + 1);
    }
    const fileEditRepeat = Math.max(0, ...this.editCounts.values()) - 1; // 第 2 次起算"重复"

    // 4. token 斜率：滑动窗口（最近 3 个观察点）的每观察点均耗
    this.tokenHistory.push({ ms: obs.nowMs, tokens: obs.tokensUsed });
    if (this.tokenHistory.length > 4) this.tokenHistory.shift();
    const tokenSlope = this.tokenHistory.length >= 3
      ? (this.tokenHistory.slice(-3).reduce((s, p) => s + p.tokens, 0)) / 3
      : 0;

    // 5. 空转思考：本轮零工具调用连续计数
    const noTool = obs.tools.length === 0;
    this.lastSignals = {
      reportGapMs: obs.nowMs - this.lastSubstantiveMs,
      sameErrorStreak: this.errorStreak,
      fileEditRepeat,
      tokenSlope: Math.round(tokenSlope * 100) / 100,
      hoohDenyStreak,
      turnNoToolStreak: noTool ? this.lastSignals.turnNoToolStreak + 1 : 0,
      handleOrphans: obs.handleOrphans,
    };
    return this.lastSignals;
  }

  /** 供 Watchdog 直接消费的最新信号。 */
  current(): TelemetrySignals {
    return this.lastSignals;
  }
}

/** 基线 token 斜率（tokenSlope 表达式的 3x baseline）：前 10 个观察点均值。 */
export class BaselineTracker {
  private readonly samples: number[] = [];
  private baseline = 0;

  push(tokens: number): void {
    this.samples.push(tokens);
    if (this.samples.length <= 10) {
      this.baseline = this.samples.reduce((s, x) => s + x, 0) / this.samples.length;
    }
  }

  current(): number {
    return this.baseline;
  }
}
