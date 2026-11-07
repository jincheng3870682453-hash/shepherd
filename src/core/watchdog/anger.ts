/**
 * 怒气状态机（core/watchdog）—— 介入额度的连续化（docs/003 §5）。
 *
 * origin: jinchen-halfdup/jcf/middleware.py GrudgeMode（参数 v1 原样继承）
 * behavior-diff:
 *   1. GrudgeMode 面向"用户行为"（垃圾输入），此处面向"Watchdog 介入"——
 *      on_fuse→onIntervention、on_valid_input→onDecaySignal，映射语义不同、参数相同。
 *   2. 时间衰减取"自上次动作起的 elapsed"计算（与原版一致），时钟由调用方注入。
 *   3. 门控表（003 §5）为 Shepherd 新增：怒气决定下次介入的允许级别。
 */
import type { WatchdogIntervenedPayload } from '../events.ts';

export type InterventionLevel = 'observe' | 'nudge' | 'restart' | 'escalate';

/** 怒气门控表（003 §5）。 */
export function angerAllows(anger: number, level: InterventionLevel): { allowed: boolean; requiresDualEvidence?: boolean; demoteTo?: InterventionLevel } {
  if (level === 'observe') return { allowed: true };
  if (level === 'escalate') return { allowed: true };
  if (anger < 50) return { allowed: true };
  if (anger < 80) {
    // 50-79：restart 需双证据，否则降级 nudge
    return level === 'restart' ? { allowed: true, requiresDualEvidence: true } : { allowed: true };
  }
  // ≥80：咬怕了，只观察 + 升级给人
  return level === 'restart' || level === 'nudge' ? { allowed: false, demoteTo: 'observe' } : { allowed: true };
}

/** 双证据判定：脊髓命中 + 皮层判断一致（003 §4）。 */
export function dualEvidenceOk(spinalHit: boolean, cortexVerdict: 'drifting' | 'spinning' | 'healthy' | undefined): boolean {
  return spinalHit && (cortexVerdict === 'drifting' || cortexVerdict === 'spinning');
}

export class Anger {
  private value = 0;
  private lastActionMs: number;
  /** 参数（jcf GrudgeMode 原样）：介入+30、正常-16/信号、时间-10/30s。 */
  private readonly perIntervention = 30;
  private readonly perDecaySignal = 16;
  private readonly timeDecayPer30s = 10;

  constructor(nowMs: number) {
    this.lastActionMs = nowMs;
  }

  current(): number {
    return this.value;
  }

  /** 介入发生：+30（封顶 100）。 */
  onIntervention(): void {
    this.value = Math.min(100, this.value + this.perIntervention);
  }

  /** 正常信号（实质进展/皮层 healthy）：-16（下限 0）。 */
  onDecaySignal(): void {
    this.value = Math.max(0, this.value - this.perDecaySignal);
  }

  /** 时间自然冷却：-10/30s（与 onDecaySignal 取大者生效——原版 max 语义）。 */
  tick(nowMs: number): void {
    const elapsed = nowMs - this.lastActionMs;
    const decay = Math.floor((elapsed / 30_000) * this.timeDecayPer30s);
    if (decay > this.perDecaySignal) {
      this.value = Math.max(0, this.value - (decay - this.perDecaySignal));
    }
    this.lastActionMs = nowMs;
  }

  /** 下次介入的建议级别（考虑怒气与证据强度）。 */
  proposeLevel(wants: InterventionLevel, spinalHit: boolean, cortexVerdict: 'drifting' | 'spinning' | 'healthy' | undefined): { level: InterventionLevel; dualEvidenceRequired: boolean; note?: string } {
    const gate = angerAllows(this.value, wants);
    if (gate.demoteTo !== undefined) {
      return { level: gate.demoteTo, dualEvidenceRequired: false, note: `anger=${this.value} ≥80：${wants} 降级为 observe+escalate 提示` };
    }
    if (gate.requiresDualEvidence && !dualEvidenceOk(spinalHit, cortexVerdict)) {
      return { level: 'nudge', dualEvidenceRequired: false, note: `anger=${this.value} 50-79 且双证据不足：restart 降级为 nudge` };
    }
    return { level: wants, dualEvidenceRequired: gate.requiresDualEvidence === true && dualEvidenceOk(spinalHit, cortexVerdict) };
  }

  /** 介入载荷的 angerAfter 快照。 */
  snapshotFor(payload: Omit<WatchdogIntervenedPayload, 'angerAfter'>): WatchdogIntervenedPayload {
    return { ...payload, angerAfter: this.value };
  }
}
