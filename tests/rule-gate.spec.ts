import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleGate, extractFeatures, safeEvalCondition, validateRuleSet } from '../src/core/filter/rule-gate.ts';

/** 移植对拍：行为对照 jcf/rule_gate.py v2.1（同输入表，Python 原件实测为基线）。 */
describe('P3-d RuleGate 移植件（origin: jcf/rule_gate.py v2.1）', () => {
  it('特征提取：与原件对拍（asdfgh 匹配 [a-zA-Z]{3,} → 有"词"，与 Python 原版一致）', () => {
    // 对拍基线：Python 原件对 asdfgh 给 real_words=1（'asdfgh' 命中 [a-zA-Z]{3,}）
    const f1 = extractFeatures('asdfgh');
    assert.equal(f1.no_real_word, false);
    const f2 = extractFeatures('呃……那个，我想想，就是说要修一下bug');
    assert.ok(f2.hesitation_count >= 3);
    assert.equal(f2.has_real_word, true);
    const f3 = extractFeatures('aaaaaabbb');
    assert.ok(f3.repeated_char_ratio > 0.5); // 原版 0.556
    const f4 = extractFeatures('THIS IS URGENT');
    assert.equal(f4.is_all_caps, true);
    const f5 = extractFeatures('normal text 123');
    assert.equal(f5.is_all_caps, false);
    // 纯 ASCII 乱码（无字母词、有特殊符号）→ 原版 no_real_word=1
    const f6 = extractFeatures('@@@ ### !!!');
    assert.equal(f6.no_real_word, true);
    assert.ok(f6.special_char_ratio > 0.8);
  });

  it('SafeEvaluator：白名单外字段忽略、AND/OR 组合、布尔字段数值化', () => {
    const ctx = extractFeatures('这是一句正常的话');
    assert.equal(safeEvalCondition('length > 3', ctx), true);
    assert.equal(safeEvalCondition('hacker_field > 999', ctx), true); // 白名单外忽略 → 保持累积结果 true
    assert.equal(safeEvalCondition('no_real_word == 1', ctx), false);
    assert.equal(safeEvalCondition('length > 100 OR has_real_word == 1', ctx), true);
    assert.equal(safeEvalCondition('length > 100 AND has_real_word == 1', ctx), false);
  });

  it('验证失败保旧规则（原版 v2.1 原子性）', () => {
    const g = new RuleGate({ rules: [{ id: 'r1', action: 'BLOCK', pattern: '垃圾', reason: 'spam', logLevel: 'warn' }], settings: {} });
    assert.equal(g.ruleCount(), 1);
    const bad = g.load({ rules: [{ id: 'r2', action: 'NUKE' }] });
    assert.equal(bad, false);
    assert.ok(g.lastLoadError?.includes('invalid action'));
    assert.equal(g.ruleCount(), 1);
    assert.equal(g.evaluate('垃圾内容').action, 'BLOCK');
    const badRe = g.load({ rules: [{ id: 'r3', action: 'BLOCK', pattern: '([unclosed' }] });
    assert.equal(badRe, false);
    assert.ok(g.lastLoadError?.includes('invalid regex'));
    assert.equal(g.ruleCount(), 1);
  });

  it('评估：BLOCK/TRUNCATE/PASS 与首条命中优先', () => {
    const g = new RuleGate({
      rules: [
        { id: 'block-gibberish', action: 'BLOCK', pattern: '^[^a-zA-Z0-9\\u4e00-\\u9fff]+$', reason: 'gibberish', logLevel: 'warn' },
        { id: 'truncate-long', action: 'TRUNCATE', condition: 'length > 10', reason: 'too long', logLevel: 'info', truncateTo: 10 },
      ],
      settings: {},
    });
    const r1 = g.evaluate('@@@ ### !!!');
    assert.equal(r1.action, 'BLOCK');
    assert.equal(r1.matchedRule, 'block-gibberish');
    const r2 = g.evaluate('this is a very long normal sentence');
    assert.equal(r2.action, 'TRUNCATE');
    assert.equal(r2.cleanedText.length, 10);
    const r3 = g.evaluate('正常话');
    assert.equal(r3.action, 'PASS');
  });

  it('constructor 与 load 路径同一验证（pattern 都被编译）——P3-d 修复的回归测试', () => {
    const g = new RuleGate({ rules: [{ id: 'cond-rule', action: 'BLOCK', condition: 'length > 3', reason: 'r', logLevel: 'info' }], settings: {} });
    assert.equal(g.evaluate('hello').action, 'BLOCK'); // condition 路径
    const g2 = new RuleGate({ rules: [{ id: 'pat-rule', action: 'BLOCK', pattern: 'SPAM', reason: 'r', logLevel: 'info' }], settings: {} });
    assert.equal(g2.evaluate('xx SPAM yy').action, 'BLOCK'); // pattern 路径（修复前 PASS）
  });

  it('兜底规则：空规则集全放行 + isFallback 可见', () => {
    const g = new RuleGate();
    assert.equal(g.isFallback(), true);
    assert.equal(g.evaluate('anything').action, 'PASS');
  });

  it('validateRuleSet：缺 pattern/condition 拒绝', () => {
    const v = validateRuleSet({ rules: [{ id: 'x', action: 'PASS' }] });
    assert.equal(v.ok, false);
    assert.ok(v.error?.includes('neither pattern nor condition'));
  });
});
