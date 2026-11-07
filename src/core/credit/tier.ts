/**
 * 信用体系 TS 移植（core/credit/tier.ts）—— 双层信用 + 四档分级（docs/004 §1）。
 *
 * origin: jinchen-halfdup/jcf/trust_tier.py v2.1（参数原样继承）
 * behavior-diff:
 *   1. 实体从"用户"泛化为"Worker/信息源"（entity: string）；加分表由 Shepherd
 *      事件驱动（004 §1 表）替代原版"垃圾输入"语义，参数结构不变。
 *   2. CreditStore 的文件持久化不移植（core 零 I/O）——状态由总线事件推导
 *      （credit.changed），本类是纯内存引擎，持久化由 adapters 落。
 *   3. manual_vip 保留（运营手动白名单语义，对齐原版）。
 *
 * 参数（原版常量，v1 原样）：
 *   会话惩罚 5 / 连续垃圾上限 3 / 连击扣 15 / 会话内最大扣 30 /
 *   时间衰减：30 天阈值、0.5/天、均值 50、最大 20 / 新实体默认 30。
 */
export type TrustTier = 'NEWCOMER' | 'NORMAL' | 'TRUSTED' | 'VIP';

/** 加减分表（docs/004 §1，事件 → Δcur）。 */
export type CreditEventKind =
  | 'ready_verified'        // +8 报告 ready 且后验为真
  | 'blocked_verified'      // +3 报告 blocked 且理由被证实
  | 'ready_falsified'       // -25 报告 ready 但后验不实（诱饵在而声称全过）
  | 'recovered_after_nudge' // +2 被 nudge 后恢复实质进展
  | 'restarted'             // -10 被 restart
  | 'relapsed_after_restart'// -15 restart 后重犯同指纹
  | 'hooh_denied'           // -4 HooH 拒绝（试探边界）
  | 'watchdog_missed'       // -20 漏放由人手工止损
  | 'source_garbage';       // -5 信息源产出垃圾

export const CREDIT_DELTAS: Record<CreditEventKind, number> = {
  ready_verified: 8,
  blocked_verified: 3,
  ready_falsified: -25,
  recovered_after_nudge: 2,
  restarted: -10,
  relapsed_after_restart: -15,
  hooh_denied: -4,
  watchdog_missed: -20,
  source_garbage: -5,
};

/** 实体信用档案（原版 UserCredit 对齐）。 */
export interface EntityCredit {
  readonly entity: string;
  base: number;              // 基础信用（慢）
  cur: number;               // 当前信用（敏感，会话内直接作用）
  createdAtMs: number;
  lastSessionEndMs: number;
  manualVip: boolean;
}

export interface SessionCreditState {
  readonly baseScore: number;
  penalty: number;
  garbageStreak: number;
  goodStreak: number;
  tempDeduction: number;
}

/** 原版 TrustEngine 常量。 */
export const TRUST_PARAMS = {
  INACTIVITY_THRESHOLD_DAYS: 30,
  DECAY_PER_DAY: 0.5,
  MEAN_SCORE: 50,
  MAX_DECAY: 20,
  SESSION_PENALTY: 5,
  GARBAGE_STREAK_LIMIT: 3,
  STREAK_PENALTY: 15,
  MAX_TEMP_DEDUCTION: 30,
  DEFAULT_SCORE: 30,
} as const;

const MS_PER_DAY = 86_400_000;

export class CreditEngine {
  private readonly entities = new Map<string, EntityCredit>();
  private readonly sessions = new Map<string, SessionCreditState>();

  /** 取实体档案（无则建：默认 30——原版 get_or_create）。 */
  get(entity: string, nowMs: number): EntityCredit {
    let c = this.entities.get(entity);
    if (c === undefined) {
      c = { entity, base: TRUST_PARAMS.DEFAULT_SCORE, cur: TRUST_PARAMS.DEFAULT_SCORE, createdAtMs: nowMs, lastSessionEndMs: nowMs, manualVip: false };
      this.entities.set(entity, c);
    }
    return c;
  }

  /** 生效信用 = 时间衰减后的 base（原版 _apply_time_decay 逐语义对齐）。 */
  effectiveScore(entity: string, nowMs: number): number {
    const c = this.get(entity, nowMs);
    const daysSinceLast = (nowMs - c.lastSessionEndMs) / MS_PER_DAY;
    const daysSinceCreate = (nowMs - c.createdAtMs) / MS_PER_DAY;
    if (daysSinceCreate < TRUST_PARAMS.INACTIVITY_THRESHOLD_DAYS) return c.base;
    if (daysSinceLast < TRUST_PARAMS.INACTIVITY_THRESHOLD_DAYS) return c.base;
    const excessDays = daysSinceLast - TRUST_PARAMS.INACTIVITY_THRESHOLD_DAYS;
    const decay = Math.min(TRUST_PARAMS.MAX_DECAY, excessDays * TRUST_PARAMS.DECAY_PER_DAY);
    if (c.base > TRUST_PARAMS.MEAN_SCORE) return Math.max(TRUST_PARAMS.MEAN_SCORE, c.base - decay);
    if (c.base < TRUST_PARAMS.MEAN_SCORE) return Math.min(TRUST_PARAMS.MEAN_SCORE, c.base + decay);
    return c.base;
  }

  tier(score: number, manualVip: boolean): TrustTier {
    if (manualVip || score >= 90) return 'VIP';
    if (score >= 70) return 'TRUSTED';
    if (score >= 30) return 'NORMAL';
    return 'NEWCOMER';
  }

  tierOf(entity: string, nowMs: number): TrustTier {
    const c = this.get(entity, nowMs);
    return this.tier(this.effectiveScore(entity, nowMs), c.manualVip);
  }

  /** 会话开始：临时信用 = 生效信用 - 5（原版 begin_session）。 */
  beginSession(entity: string, nowMs: number): SessionCreditState {
    const base = Math.floor(this.effectiveScore(entity, nowMs));
    const s: SessionCreditState = { baseScore: base, penalty: TRUST_PARAMS.SESSION_PENALTY, garbageStreak: 0, goodStreak: 0, tempDeduction: 0 };
    this.sessions.set(entity, s);
    const c = this.get(entity, nowMs);
    c.cur = base - TRUST_PARAMS.SESSION_PENALTY;
    return s;
  }

  /** 事件落账：作用在 cur 上；会话内垃圾连击走 STREAK 路径（原版 on_garbage_input 语义）。 */
  applyEvent(entity: string, kind: CreditEventKind, nowMs: number): { cur: number; base: number; delta: number } {
    const c = this.get(entity, nowMs);
    if (this.sessions.get(entity) === undefined) this.beginSession(entity, nowMs);
    const s = this.sessions.get(entity)!;
    let delta = CREDIT_DELTAS[kind];
    if (kind === 'source_garbage' || kind === 'ready_falsified') {
      // 连击路径：连续 3 次垃圾/造假 → 立即降权 +15（原版 STREAK_PENALTY，上限 30）
      s.garbageStreak++;
      if (s.garbageStreak >= TRUST_PARAMS.GARBAGE_STREAK_LIMIT) {
        const extra = Math.min(TRUST_PARAMS.STREAK_PENALTY, TRUST_PARAMS.MAX_TEMP_DEDUCTION - s.tempDeduction);
        if (extra > 0) {
          delta -= extra;
          s.tempDeduction += extra;
        }
        s.garbageStreak = 0;
      }
    } else {
      s.garbageStreak = 0;
      s.goodStreak++;
    }
    c.cur = Math.max(0, Math.min(100, c.cur + delta));
    // base 慢跟（回写比例：cur 变化的 20% 向 base 传导——原版 end_session 回写的会话内近似）
    c.base = Math.max(0, Math.min(100, Math.round(c.base + delta * 0.2)));
    return { cur: c.cur, base: c.base, delta };
  }

  /** 会话结束：按比例回写（原版 end_session 简化：cur 向 base 全量漂移的 20% 已在 applyEvent 内发生）。 */
  endSession(entity: string, nowMs: number): void {
    const c = this.get(entity, nowMs);
    c.lastSessionEndMs = nowMs;
    this.sessions.delete(entity);
  }

  /** 快照（Watchdog/预算函数读取）。 */
  current(entity: string, nowMs: number): number {
    return this.get(entity, nowMs).cur;
  }
}
