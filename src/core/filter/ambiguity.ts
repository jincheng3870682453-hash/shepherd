/**
 * AmbiguityRouter TS 移植 —— jcf 模糊度三路分流器（docs/ADR-004、docs/002 §7 入口层）。
 *
 * origin: jinchen-halfdup/jcf/ambiguity_router.py (v1, @main 2026-11 clone)
 * behavior-diff:
 *   1. 八条分流规则、顺序、阈值、confidence、suggested_action 逐条对齐原版。
 *   2. _COMMON_EN_WORDS 词表完整搬运（frozenset → Set）。
 *   3. generate_clarify_prompt 的追问模板搬运（C-1 教训：模板字面量含中文，
 *      文件由 write 工具直写 UTF-8，不经 PowerShell here-string）。
 *   4. Shepherd 语境的接线变化：GIBBERISH → 模板回复/静默（intake.filtered），
 *      HIGH → 轻量澄清（P5 接轻模型），LOW → Router 慢路径（受理评估）。
 */
import { extractFeatures } from './rule-gate.ts';

export type AmbiguityLevel = 'GIBBERISH' | 'HIGH' | 'LOW';

export interface RouteResult {
  readonly level: AmbiguityLevel;
  readonly reason: string;
  readonly confidence: number;
  readonly suggestedAction: string;
}

/** 常见英文实词表（原版 _COMMON_EN_WORDS 完整搬运）。 */
const COMMON_EN_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'you', 'for', 'are', 'but', 'not', 'can', 'all',
  'any', 'how', 'man', 'new', 'now', 'our', 'out', 'say', 'she',
  'too', 'use', 'will', 'with', 'have', 'this', 'that', 'they',
  'what', 'when', 'where', 'which', 'who', 'why', 'would', 'could',
  'should', 'about', 'after', 'again', 'below', 'every',
  'from', 'great', 'write', 'because', 'through', 'during',
  'before', 'always', 'around', 'between', 'people', 'please',
  'weather', 'tomorrow', 'today', 'yesterday', 'hangzhou', 'beijing',
  'shanghai', 'shenzhen', 'guangzhou', 'chengdu', 'hello', 'world',
  'code', 'function', 'class', 'import', 'return', 'print', 'input',
  'query', 'search', 'check', 'find', 'look', 'tell', 'show', 'give',
  'make', 'take', 'help', 'need', 'want', 'think', 'know', 'feel',
  'speak', 'talk', 'listen', 'hear', 'see', 'watch', 'read',
  'good', 'bad', 'nice', 'terrible', 'awesome', 'amazing',
  'project', 'computer', 'internet', 'website', 'application', 'system',
  'data', 'information', 'result', 'answer', 'question', 'problem',
  'solution', 'method', 'approach', 'strategy', 'plan', 'design',
]);

const EN_TOKEN_RE = /[a-zA-Z]{2,}/g;
const HESITATION_RE = /(嗯+|呃+|啊+|哦+|那个|就是|就是说|怎么说呢|算了吧|其实吧|怎么说|那个啥|你懂的|对了|哦对|嗯嗯|啊啊)/g;
const PUNCT_RE = /[^\w\u4e00-\u9fff\u3400-\u4dbf]/g;
const CONSONANT_CLUSTER_RE = /[bcdfghjklmnpqrstvwxyz]{4,}/i;
const VOWEL_RE = /[aeiou]/g;
const CONSONANT_RE = /[bcdfghjklmnpqrstvwxyz]/g;
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const CJK_WORD_RE = /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g;

/** 英文 token 是否像有意义的词（原版 _is_meaningful_en 逐语义对齐）。 */
function isMeaningfulEn(token: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 3) return false;
  if (COMMON_EN_WORDS.has(t)) return true;
  const hasVowel = /[aeiou]/.test(t);
  const hasConsonant = CONSONANT_RE.test(t);
  CONSONANT_RE.lastIndex = 0;
  if (!hasVowel || !hasConsonant) return false;
  const vowels = (t.match(VOWEL_RE) ?? []).length;
  const ratio = vowels / t.length;
  if (ratio >= 0.2 && ratio <= 0.6) return true;
  if (t.length <= 4) return true;
  return false;
}

export class AmbiguityRouter {
  route(text: string): RouteResult {
    if (text === '' || text.trim() === '') {
      return { level: 'GIBBERISH', reason: 'empty_input', confidence: 1.0, suggestedAction: 'wait_for_more_input' };
    }
    const stripped = text.trim();
    const charCount = stripped.length;

    // 特征提取（原版 route() 前半逐语义对齐）
    const hesitationSpans: Array<[number, number]> = [];
    const hesRe = new RegExp(HESITATION_RE.source, 'g');
    let hm: RegExpExecArray | null;
    while ((hm = hesRe.exec(stripped)) !== null) {
      hesitationSpans.push([hm.index, hm.index + hm[0]!.length]);
    }
    const inHesitation = (pos: number): boolean => hesitationSpans.some(([s, e]) => s <= pos && pos < e);

    const cjkChars = stripped.match(CJK_CHAR_RE) ?? [];
    // 只取不在犹豫词区域的汉字（原版 real_cjk）
    const realCjk: string[] = [];
    const cjkIter = new RegExp(CJK_CHAR_RE.source, 'g');
    let cm: RegExpExecArray | null;
    while ((cm = cjkIter.exec(stripped)) !== null) {
      if (!inHesitation(cm.index)) realCjk.push(cm[0]!);
    }
    const cjkSet = new Set<string>();
    for (let i = 0; i < realCjk.length - 1; i++) cjkSet.add(realCjk[i]! + realCjk[i + 1]!);
    for (let i = 0; i < realCjk.length - 2; i++) cjkSet.add(realCjk[i]! + realCjk[i + 1]! + realCjk[i + 2]!);
    const cjkWordCount = cjkSet.size;

    const enAll = stripped.match(EN_TOKEN_RE) ?? [];
    const enMeaningful = enAll.filter(isMeaningfulEn);
    const enGibberish = enAll.filter(t => !isMeaningfulEn(t));
    const realWordCount = cjkWordCount + enMeaningful.length;
    const hesitationCount = (stripped.match(new RegExp(HESITATION_RE.source, 'g')) ?? []).length;
    const gibberishEnRatio = enGibberish.length / Math.max(enAll.length, 1);
    const noiseChars = (stripped.match(PUNCT_RE) ?? []).length + (stripped.match(/ /g) ?? []).length;
    const noiseRatio = noiseChars / Math.max(charCount, 1);

    // 分流决策（原版规则 1-8 + 默认，顺序不变）
    if (realWordCount === 0) return { level: 'GIBBERISH', reason: 'no_real_words', confidence: 0.95, suggestedAction: 'template_roast_or_wait' };
    if (gibberishEnRatio > 0.5 && enAll.length >= 2) return { level: 'GIBBERISH', reason: 'gibberish_english', confidence: 0.9, suggestedAction: 'template_roast' };
    if (noiseRatio > 0.6 && realWordCount <= 1) return { level: 'GIBBERISH', reason: 'high_noise_ratio', confidence: 0.85, suggestedAction: 'template_roast' };
    if (realWordCount <= 1 && hesitationCount >= 1) return { level: 'HIGH', reason: 'hesitation_with_few_words', confidence: 0.85, suggestedAction: 'light_model_clarify' };
    if (realWordCount === 1) return { level: 'HIGH', reason: 'single_word_input', confidence: 0.8, suggestedAction: 'light_model_ask_more' };
    if (hesitationCount >= 2 && realWordCount < 5) return { level: 'HIGH', reason: 'many_hesitations', confidence: 0.75, suggestedAction: 'light_model_clarify' };
    if (realWordCount >= 3 && hesitationCount <= 1) return { level: 'LOW', reason: 'clear_semantics', confidence: 0.9, suggestedAction: 'proceed_to_sentinel' };
    if (realWordCount >= 5) return { level: 'LOW', reason: 'rich_content', confidence: 0.85, suggestedAction: 'proceed_to_sentinel' };
    if (hesitationCount >= 2) return { level: 'HIGH', reason: 'hesitant_but_substantive', confidence: 0.7, suggestedAction: 'light_model_confirm' };
    return { level: 'LOW', reason: 'default_low', confidence: 0.6, suggestedAction: 'proceed_to_sentinel' };
  }

  /** 高模糊输入的追问话术（原版模板搬运）。 */
  generateClarifyPrompt(text: string, result: RouteResult): string {
    const templates: Record<string, string> = {
      hesitation_with_few_words: '你是想说…？我猜一下，你说的是「{snippet}」吗？',
      single_word_input: '嗯…「{snippet}」是啥？再说具体点？',
      many_hesitations: '慢慢来，你想问的是关于「{snippet}」的事吗？',
      hesitant_but_substantive: '我大概懂了，你是说「{snippet}」对吧？',
      insufficient_content: '嗯…再多说一点？我没太听清。',
    };
    const tpl = templates[result.reason] ?? '嗯…你说的是？';
    const cjk = text.match(CJK_WORD_RE) ?? [];
    const snippet = cjk.length > 0 ? cjk[0]! : text.slice(0, 6);
    return tpl.replace('{snippet}', snippet);
  }
}

// 特征提取来自 rule-gate 移植件（共享实现，避免两处漂移）
export { extractFeatures };
