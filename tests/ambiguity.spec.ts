import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmbiguityRouter } from '../src/core/filter/ambiguity.ts';

/** 移植对拍：行为对照 jcf/ambiguity_router.py v1（同输入表）。 */
describe('P3-d AmbiguityRouter 移植件（origin: jcf/ambiguity_router.py v1）', () => {
  const router = new AmbiguityRouter();

  it('空输入 → GIBBERISH（empty_input）', () => {
    const r = router.route('   ');
    assert.equal(r.level, 'GIBBERISH');
    assert.equal(r.reason, 'empty_input');
  });

  it('纯乱码 → GIBBERISH（no_real_words）', () => {
    const r = router.route('@@@ ### !!!');
    assert.equal(r.level, 'GIBBERISH');
    assert.equal(r.reason, 'no_real_words');
  });

  it('清晰中文请求 → LOW（clear_semantics）', () => {
    const r = router.route('请帮我修复登录页面的报错问题，并写好测试');
    assert.equal(r.level, 'LOW');
    assert.equal(r.reason, 'clear_semantics');
  });

  it('清晰英文请求 → LOW', () => {
    const r = router.route('fix the login bug and add tests for it');
    assert.equal(r.level, 'LOW');
  });

  it('单词输入 → HIGH（single_word_input）', () => {
    const r = router.route('登录');
    assert.equal(r.level, 'HIGH');
    assert.equal(r.reason, 'single_word_input');
  });

  it('犹豫多实词少 → HIGH（many_hesitations）', () => {
    const r = router.route('嗯……那个……就是……怎么说呢……那个bug');
    assert.equal(r.level, 'HIGH');
  });

  it('追问话术：模板命中 + snippet 填充', () => {
    const r = router.route('那个bug');
    const p = router.generateClarifyPrompt('那个bug', r);
    assert.ok(p.includes('「'), '模板应含 snippet 占位符渲染');
    assert.ok(p.length > 5);
  });

  it('接线语义：GIBBERISH 不进慢路径、LOW 进受理（Shepherd 002 §7）', () => {
    const r1 = router.route('@@@');
    assert.notEqual(r1.suggestedAction, 'proceed_to_sentinel');
    const r2 = router.route('请修复 CI 里的测试失败并报告结果');
    assert.equal(r2.suggestedAction, 'proceed_to_sentinel');
  });
});
