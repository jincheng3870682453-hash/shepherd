/**
 * 脊髓规则引擎（core/watchdog）—— 确定性介入建议（docs/003 §3）。
 *
 * origin: jinchen-halfdup/jcf/rule_gate.py 热更新纪律（validate-then-swap、失败保旧）
 *         + HooH STALL 规则（"读类成功不算进展"进遥测定义）
 * behavior-diff:
 *   1. 规则字段：id/when/propose/evidence——when 用 SafeEvaluator 同款白名单
 *      表达式（字段=遥测信号+credit+anger），禁止任意代码。
 *   2. credit_scaled(x) 阈值乘数在表达式里体现为 credit 阈值字段（004 §3），
 *      由调用方在构造 ctx 时折算——core 不持有信用模块依赖。
 *   3. 规则产出"建议"，执行经怒气门控（anger.ts）——提议-裁决分离（003 §1 不变式 3）。
 */
import { safeEvalCondition } from '../filter/rule-gate.ts';
import type { FeatureContext } from '../filter/rule-gate.ts';
import type { TelemetrySignals } from '../events.ts';
import type { InterventionLevel } from './anger.ts';

export interface SpinalContext extends FeatureContext {
  /** 信用（0-100）。 */
  readonly credit: number;
  /** 当前怒气。 */
  readonly anger: number;
  /** 会话类型（worker/router/cortex）。 */
  readonly sessionType: string;
}

/** SpinalContext 同时要当 FeatureContext 用（字段并集）。 */
function toFeatureLike(ctx: SpinalContext): Record<string, unknown> {
  return { ...(ctx as unknown as Record<string, unknown>) };
}

export interface SpinalRule {
  readonly id: string;
  /** SafeEvaluator 白名单表达式（字段：遥测信号/credit/anger）。 */
  readonly when: string;
  readonly propose: InterventionLevel;
  /** 命中证据的字段名列表（003 §1 不变式 4）。 */
  readonly evidence: readonly string[];
}

export interface SpinalHit {
  readonly ruleId: string;
  readonly propose: InterventionLevel;
  readonly evidence: ReadonlyArray<{ field: string; value: unknown }>;
}

export interface SpinalVerdict {
  /** 是否有脊髓命中（双证据判定用）。 */
  readonly hit: boolean;
  /** 最高优先级建议（规则表顺序即优先级）。 */
  readonly propose: InterventionLevel | null;
  readonly hits: ReadonlyArray<SpinalHit>;
}

const SIGNAL_FIELDS = new Set([
  'reportGapMs', 'sameErrorStreak', 'fileEditRepeat', 'tokenSlope',
  'hoohDenyStreak', 'turnNoToolStreak', 'handleOrphans',
  'credit', 'anger',
]);

export class SpinalEngine {
  private rules: readonly SpinalRule[] = [];
  private loadError: string | null = null;
  private reloads = 0;

  constructor(initial?: readonly SpinalRule[]) {
    if (initial !== undefined && initial.length > 0) this.rules = initial;
    if (this.rules.length === 0) this.installFallback();
  }

  /** 原子加载：validate-then-swap（继承 jcf 纪律）。 */
  load(rules: readonly SpinalRule[]): boolean {
    for (const r of rules) {
      if (!SIGNAL_FIELDS.has('') && (r.when === undefined || r.when === '')) {
        this.loadError = `Rule '${r.id}' has empty when`;
        return false;
      }
      if (!['observe', 'nudge', 'restart', 'escalate'].includes(r.propose)) {
        this.loadError = `Rule '${r.id}' has invalid propose: ${r.propose}`;
        return false;
      }
    }
    this.rules = rules;
    this.loadError = null;
    this.reloads++;
    return true;
  }

  private installFallback(): void {
    // 默认规则表（003 §3 的五条示例落地；credit_scaled 用阈值常数近似——
    // 阈值由 credit 字段直接参与表达式）
    this.rules = [
      { id: 'same-error-loop', when: 'sameErrorStreak >= 3', propose: 'nudge', evidence: ['sameErrorStreak'] },
      { id: 'no-progress-long', when: 'reportGapMs > 2700000 AND turnNoToolStreak >= 5', propose: 'nudge', evidence: ['reportGapMs', 'turnNoToolStreak'] },
      { id: 'thrash-edit', when: 'fileEditRepeat >= 4', propose: 'nudge', evidence: ['fileEditRepeat'] },
      { id: 'boundary-probe', when: 'hoohDenyStreak >= 5', propose: 'escalate', evidence: ['hoohDenyStreak'] },
      { id: 'burn-rate', when: 'tokenSlope > 3 AND handleOrphans == 0', propose: 'nudge', evidence: ['tokenSlope'] },
    ];
  }

  /** 评估：按表序取首个命中（优先级 = 表序）。 */
  evaluate(signals: TelemetrySignals, credit: number, anger: number): SpinalVerdict {
    const ctx: SpinalContext = {
      ...signals,
      credit,
      anger,
      sessionType: 'worker',
      length: signals.reportGapMs, // FeatureContext 形状兼容（遥测字段全在白名单里）
      special_char_ratio: 0,
      repeated_char_ratio: 0,
      no_real_word: false,
      has_real_word: true,
      real_word_count: 1,
      hesitation_count: 0,
      is_all_caps: false,
      digit_ratio: 0,
    };
    const record = toFeatureLike(ctx) as Record<string, unknown>;
    const hits: SpinalHit[] = [];
    for (const rule of this.rules) {
      const matched = safeEvalCondition(rule.when, ctx);
      if (!matched) continue;
      hits.push({
        ruleId: rule.id,
        propose: rule.propose,
        evidence: rule.evidence.map(field => ({ field, value: record[field] })),
      });
    }
    return { hit: hits.length > 0, propose: hits[0]?.propose ?? null, hits };
  }

  hasLoadError(): boolean {
    return this.loadError !== null;
  }

  lastError(): string | null {
    return this.loadError;
  }
}
