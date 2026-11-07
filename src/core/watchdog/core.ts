/**
 * Watchdog 编排（core/watchdog）—— 独立监督回路的语义核心（docs/003）。
 *
 * 不变式（003 §1）：
 *   1. 独立性：本类不 import 主系统组件；输入靠事件注入。
 *   2. 无语义输入：皮层输入只有强类型遥测（TelemetrySignals），永不收自由文本（ADR-002）。
 *   3. 提议-裁决分离：皮层/脊髓只产判断；动作经怒气门控（anger.ts）。
 *   4. 可审计：每次介入带 evidence[]，事件由调用方（apps 层）落总线。
 */
import type { TelemetrySignals } from '../events.ts';
import { Anger, type InterventionLevel } from './anger.ts';
import { SpinalEngine, type SpinalVerdict } from './spinal.ts';

export type CortexVerdict = 'healthy' | 'drifting' | 'spinning' | undefined;

export interface WatchdogInput {
  readonly sessionId: string;
  readonly signals: TelemetrySignals;
  readonly credit: number;
  readonly nowMs: number;
}

export interface WatchdogDecision {
  readonly level: InterventionLevel;
  readonly target: string;
  readonly evidence: ReadonlyArray<{ field: string; value: unknown }>;
  readonly angerAfter: number;
  readonly note?: string | undefined;
  /** 皮层判断（有唤醒时携带；输出进审计链，永不回流为 LLM 输入——ADR-002）。 */
  readonly cortex?: CortexVerdict;
}

/** 皮层接口：三值判断（apps 层接 LLM；core 用注入，测试用桩）。 */
export type CortexJudge = (sessionId: string, signals: TelemetrySignals) => Promise<'healthy' | 'drifting' | 'spinning'>;

/** 介入执行器端口（apps 层实现：nudge=投递事件、restart=杀+回滚+重开、escalate=面板）。 */
export interface InterventionExecutor {
  execute(sessionId: string, level: InterventionLevel, evidence: ReadonlyArray<{ field: string; value: unknown }>): Promise<void>;
}

export class WatchdogCore {
  readonly anger: Anger;
  readonly spinal: SpinalEngine;
  private readonly cortexJudge: CortexJudge | null;
  private readonly executor: InterventionExecutor | null;
  /** 皮层兜底巡检间隔（003 §4：15min 一轮 top 风险；简化为全局间隔）。 */
  private lastCortexRunMs = 0;

  constructor(opts: { nowMs: number; rules?: import('./spinal.ts').SpinalRule[]; cortexJudge?: CortexJudge; executor?: InterventionExecutor }) {
    this.anger = new Anger(opts.nowMs);
    this.spinal = new SpinalEngine(opts.rules);
    this.cortexJudge = opts.cortexJudge ?? null;
    this.executor = opts.executor ?? null;
    this.lastCortexRunMs = opts.nowMs;
  }

  /**
   * 主入口：一批遥测到达 → 脊髓评估 → （可选皮层唤醒）→ 怒气门控 → 介入。
   * 皮层唤醒条件：脊髓命中（003 §4）或兜底巡检间隔到（默认 15min）。
   */
  async observe(input: WatchdogInput): Promise<WatchdogDecision | null> {
    this.anger.tick(input.nowMs);
    const verdict: SpinalVerdict = this.spinal.evaluate(input.signals, input.credit, this.anger.current());

    // 皮层唤醒判定
    const cortexDue = input.nowMs - this.lastCortexRunMs >= 15 * 60_000;
    let cortexVerdict: CortexVerdict;
    if (verdict.hit && this.cortexJudge !== null) {
      cortexVerdict = await this.cortexJudge(input.sessionId, input.signals);
    } else if (cortexDue && this.cortexJudge !== null) {
      cortexVerdict = await this.cortexJudge(input.sessionId, input.signals);
      this.lastCortexRunMs = input.nowMs;
    } else {
      cortexVerdict = undefined;
    }

    if (verdict.propose === null) {
      // 无脊髓命中：若皮层在兜底巡检中判 drifting/spinning，也可升级提议
      if (cortexVerdict === 'drifting' || cortexVerdict === 'spinning') {
        const proposal = this.anger.proposeLevel('nudge', false, cortexVerdict);
        return await this.act(input, proposal.level, [{ field: 'cortex', value: cortexVerdict }], cortexVerdict, proposal.note);
      }
      // healthy 或无皮层：正常衰减信号
      this.anger.onDecaySignal();
      return null;
    }

    // 脊髓命中：按怒气门控定级
    const proposal = this.anger.proposeLevel(verdict.propose, verdict.hit, cortexVerdict);
    return await this.act(input, proposal.level, verdict.hits.flatMap(h => h.evidence), cortexVerdict, proposal.note);
  }

  private async act(input: WatchdogInput, level: InterventionLevel, evidence: ReadonlyArray<{ field: string; value: unknown }>, cortex: CortexVerdict, note?: string): Promise<WatchdogDecision> {
    this.anger.onIntervention();
    const decision: WatchdogDecision = {
      level,
      target: input.sessionId,
      evidence,
      angerAfter: this.anger.current(),
      ...(note !== undefined ? { note } : {}),
      ...(cortex !== undefined ? { cortex } : {}),
    };
    if (this.executor !== null && level !== 'observe') {
      await this.executor.execute(input.sessionId, level, evidence);
    }
    return decision;
  }

  /** 看住看门狗（003 §6）：介入统计快照。 */
  stats(): { anger: number } {
    return { anger: this.anger.current() };
  }
}
