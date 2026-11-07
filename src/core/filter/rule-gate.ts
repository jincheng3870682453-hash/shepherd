/**
 * RuleGate TS 移植 —— jcf 入口过滤第一道硬闸门（docs/ADR-004、docs/002 §7 入口层）。
 *
 * origin: jinchen-halfdup/jcf/rule_gate.py (v2.1, @main 2026-11 clone)
 * behavior-diff:
 *   1. 配置源：YAML 文件 → 内存规则集（热更新 API 不变：validate-then-swap 原子替换、
 *      失败保旧规则）。文件监控由调用方（adapters）负责，core 不做 I/O（910 §2）。
 *   2. Action 枚举与 GateResult 形状一致；TRUNCATE 语义一致（截断并标记）。
 *   3. 告警计数（_record_alert）不移植：Shepherd 中告警走总线事件（intake.filtered
 *      + credit.changed），core 内不维护计数器状态。
 *   4. features 与 SafeEvaluator 语义逐字段对齐（见 safe-evaluator.ts 注释）。
 *
 * 热更新纪律（继承原版 v2.1）：加载到临时对象 → 逐条验证（正则编译/字段完整）→
 * 全部通过才原子替换 → 任何失败保旧规则 + 记 lastLoadError。
 */

export type GateAction = 'BLOCK' | 'WAIT' | 'PASS' | 'TRUNCATE';

export interface GateResult {
  readonly action: GateAction;
  readonly reason: string;
  readonly matchedRule: string | null;
  readonly cleanedText: string;
  readonly logLevel: string;
  readonly truncated: boolean;
  readonly truncateLength?: number | undefined;
}

export interface GateRule {
  readonly id: string;
  readonly action: GateAction;
  /** 正则或 condition 至少其一。 */
  readonly pattern?: string | undefined;
  readonly condition?: string | undefined;
  readonly reason: string;
  readonly logLevel: string;
  readonly truncateTo?: number | undefined;
  /** 编译产物（validate 阶段生成；不进序列化）。 */
  readonly compiled?: RegExp | undefined;
}

export interface GateSettings {
  readonly alertWindowSeconds?: number | undefined;
  readonly alertThreshold?: number | undefined;
}

/** 白名单字段（继承 SafeEvaluator.ALLOWED_FIELDS；禁 eval 的极简表达式求值器见 safe-evaluator.ts）。 */
export interface FeatureContext {
  readonly length: number;
  readonly special_char_ratio: number;
  readonly repeated_char_ratio: number;
  readonly no_real_word: boolean;
  readonly has_real_word: boolean;
  readonly real_word_count: number;
  readonly hesitation_count: number;
  readonly is_all_caps: boolean;
  readonly digit_ratio: number;
}

// ── 特征提取（原版 _extract_features 逐字段对齐） ─────────────────────

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g;
const EN_RE = /[a-zA-Z]{3,}/g;
const REPEAT_RE = /(.)\1{2,}/g;
const HESITATION_RE = /(嗯+|呃+|啊+|那个|就是|就是说|怎么说呢|算了)/g;
const ALL_CAPS_RE = /[A-Z]{3,}/;
const LOWER_RE = /[a-z]/;
// 原版豁免清单：中文标点+全角引号不算 special（逐字符对齐）
const NON_SPECIAL = new Set('，。！？、；：“”‘’（） '.split(''));

export function extractFeatures(text: string): FeatureContext {
  const length = text.length;
  if (length === 0) {
    return { length: 0, special_char_ratio: 0, repeated_char_ratio: 0, no_real_word: true, has_real_word: false, real_word_count: 0, hesitation_count: 0, is_all_caps: false, digit_ratio: 0 };
  }
  const cjk = text.match(CJK_RE) ?? [];
  const en = text.match(EN_RE) ?? [];
  const realWords = cjk.length + en.length;

  let special = 0;
  for (const c of text) if (!/[a-zA-Z0-9]/.test(c) && !NON_SPECIAL.has(c)) special++;
  const specialRatio = special / length;

  let repeatExtra = 0;
  const repeats = text.match(REPEAT_RE) ?? [];
  for (const grp of repeats) repeatExtra += grp.length - 2;
  const repeatRatio = repeatExtra / Math.max(length, 1);

  const hesitation = (text.match(HESITATION_RE) ?? []).length;
  const isAllCaps = ALL_CAPS_RE.test(text) && !LOWER_RE.test(text);
  let digits = 0;
  for (const c of text) if (c >= '0' && c <= '9') digits++;

  return {
    length,
    special_char_ratio: Math.round(specialRatio * 1000) / 1000,
    repeated_char_ratio: Math.round(repeatRatio * 1000) / 1000,
    no_real_word: realWords === 0,
    has_real_word: realWords > 0,
    real_word_count: realWords,
    hesitation_count: hesitation,
    is_all_caps: isAllCaps,
    digit_ratio: Math.round((digits / length) * 1000) / 1000,
  };
}

// ── 规则验证（原版 _parse_file 的验证段） ────────────────────────────

export interface RuleSet {
  readonly rules: readonly GateRule[];
  readonly settings: GateSettings;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly rules?: readonly GateRule[];
  readonly settings?: GateSettings;
  readonly error?: string | undefined;
}

const VALID_ACTIONS = new Set<GateAction>(['BLOCK', 'WAIT', 'PASS', 'TRUNCATE']);

export function validateRuleSet(raw: { rules?: unknown; settings?: unknown }): ValidationResult {
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    return { ok: false, error: 'rules must be a list' };
  }
  const rulesRaw = (raw.rules ?? []) as Array<Record<string, unknown>>;
  const out: GateRule[] = [];
  for (let idx = 0; idx < rulesRaw.length; idx++) {
    const rule = rulesRaw[idx];
    if (typeof rule !== 'object' || rule === null) {
      return { ok: false, error: `Rule #${idx} is not a mapping` };
    }
    const id = String(rule['id'] ?? `rule_${idx}`);
    const actionStr = String(rule['action'] ?? '').toUpperCase();
    if (!VALID_ACTIONS.has(actionStr as GateAction)) {
      return { ok: false, error: `Rule '${id}' has invalid action: ${actionStr}` };
    }
    const pattern = rule['pattern'] !== undefined && rule['pattern'] !== null && String(rule['pattern']) !== '' ? String(rule['pattern']) : undefined;
    let compiled: RegExp | undefined;
    if (pattern !== undefined) {
      try {
        compiled = new RegExp(pattern);
      } catch (e) {
        return { ok: false, error: `Rule '${id}' has invalid regex: ${String(e)}` };
      }
    }
    const condition = rule['condition'] !== undefined && String(rule['condition']).trim() !== '' ? String(rule['condition']).trim() : undefined;
    if (compiled === undefined && condition === undefined) {
      return { ok: false, error: `Rule '${id}' has neither pattern nor condition` };
    }
    const truncateRaw = rule['truncate_to'] !== undefined ? rule['truncate_to'] : rule['truncateTo'];
    const truncateTo = truncateRaw !== undefined ? Number(truncateRaw) : undefined;
    out.push({
      id,
      action: actionStr as GateAction,
      pattern,
      condition,
      reason: String(rule['reason'] ?? 'matched'),
      logLevel: String(rule['log_level'] ?? 'info'),
      truncateTo: truncateTo !== undefined && Number.isFinite(truncateTo) ? truncateTo : undefined,
      compiled,
    });
  }
  const settings = (typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {}) as GateSettings;
  return { ok: true, rules: out, settings };
}

// ── RuleGate 本体（热更新 + 评估） ───────────────────────────────────

export class RuleGate {
  private rules: readonly GateRule[] = [];
  private settings: GateSettings = {};
  private fallbackInstalled = false;
  /** 监控字段（原版 v2.1 对齐）。 */
  lastLoadError: string | null = null;
  loadErrorCount = 0;
  totalReloads = 0;

  constructor(initial?: RuleSet) {
    if (initial !== undefined) {
      // constructor 路径与 load 路径同一验证（编译 pattern）——原版 __init__ 也走 _load 语义
      const v = validateRuleSet({ rules: initial.rules.map(r => ({ ...r })), settings: initial.settings });
      if (v.ok) this.swap(v.rules!, v.settings!);
      else this.swap(initial.rules, initial.settings); // 已编译的传入（load 产物）直接用
    }
    if (this.rules.length === 0) this.installFallback();
  }

  /** 原子替换：先 validate 再 swap（调用方把 YAML/JSON 解析成 raw 传入）。 */
  load(raw: { rules?: unknown; settings?: unknown }): boolean {
    const v = validateRuleSet(raw);
    if (!v.ok) {
      this.lastLoadError = v.error ?? 'unknown';
      this.loadErrorCount++;
      return false; // 保旧规则（原版 _handle_load_failure）
    }
    this.swap(v.rules!, v.settings!);
    return true;
  }

  private swap(rules: readonly GateRule[], settings: GateSettings): void {
    this.rules = rules;
    this.settings = settings;
    this.lastLoadError = null;
    this.totalReloads++;
  }

  /** 兜底规则（原版 _install_fallback_rules）：全放行——过滤不可用时宁可放行到慢路径。 */
  private installFallback(): void {
    this.rules = [{ id: 'fallback_pass_all', action: 'PASS', condition: 'always', reason: 'fallback', logLevel: 'warn' }];
    this.fallbackInstalled = true;
  }

  isFallback(): boolean {
    return this.fallbackInstalled && this.totalReloads === 0;
  }

  evaluate(text: string): GateResult {
    const cleaned = text.trim();
    const ctx = extractFeatures(cleaned);
    for (const rule of this.rules) {
      const matched = rule.compiled !== undefined ? rule.compiled.test(cleaned) : rule.condition === 'always' ? true : rule.condition !== undefined ? safeEvalCondition(rule.condition, ctx) : false;
      if (!matched) continue;
      if (rule.action === 'TRUNCATE') {
        const max = rule.truncateTo ?? 4000;
        return { action: 'TRUNCATE', reason: rule.reason, matchedRule: rule.id, cleanedText: cleaned.slice(0, max), logLevel: rule.logLevel, truncated: true, truncateLength: max };
      }
      return { action: rule.action, reason: rule.reason, matchedRule: rule.id, cleanedText: cleaned, logLevel: rule.logLevel, truncated: false };
    }
    return { action: 'PASS', reason: 'default_pass', matchedRule: null, cleanedText: cleaned, logLevel: 'debug', truncated: false };
  }

  ruleCount(): number {
    return this.rules.length;
  }
}

// ── SafeEvaluator（原版逐语义对齐：白名单字段、禁 eval） ─────────────

const ALLOWED_FIELDS = new Set([
  'length', 'special_char_ratio', 'repeated_char_ratio', 'no_real_word', 'has_real_word',
  'real_word_count', 'hesitation_count', 'is_all_caps', 'digit_ratio',
]);
const COND_TOKEN_RE = /^\s*(\w+)\s*(>|<|>=|<=|==|!=)\s*([\d.]+)\s*$/;

/** 极简表达式：field op num (AND|OR field op num)*。白名单外字段直接忽略该子句。 */
export function safeEvalCondition(condition: string, ctx: FeatureContext): boolean {
  const parts = condition.split(/\s+(AND|OR)\s+/);
  let lastOp: 'AND' | 'OR' = 'AND';
  let result = true;
  for (const token of parts) {
    if (token === 'AND' || token === 'OR') {
      lastOp = token;
      continue;
    }
    const m = COND_TOKEN_RE.exec(token);
    if (m === null) continue;
    const field = m[1]!;
    const op = m[2]!;
    const value = Number(m[3]);
    if (!ALLOWED_FIELDS.has(field)) continue; // 白名单外忽略（原版语义）
    const fv = (ctx as unknown as Record<string, unknown>)[field];
    const fvNum = typeof fv === 'boolean' ? (fv ? 1 : 0) : typeof fv === 'number' ? fv : 0;
    const r = op === '>' ? fvNum > value : op === '<' ? fvNum < value : op === '>=' ? fvNum >= value : op === '<=' ? fvNum <= value : op === '==' ? fvNum === value : fvNum !== value;
    result = lastOp === 'AND' ? result && r : result || r;
  }
  return result;
}
