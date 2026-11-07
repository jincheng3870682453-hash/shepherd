import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Anger, angerAllows, dualEvidenceOk } from '../src/core/watchdog/anger.ts';
import { SpinalEngine } from '../src/core/watchdog/spinal.ts';
import { WatchdogCore } from '../src/core/watchdog/core.ts';
import type { TelemetrySignals } from '../src/core/events.ts';

const calmSignals: TelemetrySignals = {
  reportGapMs: 10_000, sameErrorStreak: 0, fileEditRepeat: 0,
  tokenSlope: 1, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0,
};
const loopSignals: TelemetrySignals = { ...calmSignals, sameErrorStreak: 5 };

describe('P4-a 怒气状态机（origin: jcf GrudgeMode，docs/003 §5）', () => {
  it('参数继承：介入+30、正常-16、时间-10/30s', () => {
    const a = new Anger(0);
    a.onIntervention();
    assert.equal(a.current(), 30);
    a.onIntervention();
    a.onIntervention();
    assert.equal(a.current(), 90);
    a.onDecaySignal();
    assert.equal(a.current(), 74);
    a.tick(30_000); // 30s → 时间衰减 10 < 16，不生效（max 语义）
    assert.equal(a.current(), 74);
    a.tick(5 * 60_000); // 5min → 时间衰减 100 > 16 → 额外 -84 → 0
    assert.equal(a.current(), 0);
  });

  it('门控表：怒气 <50 全放行；50-79 restart 需双证据；≥80 只 observe/escalate', () => {
    assert.deepEqual(angerAllows(30, 'restart'), { allowed: true });
    assert.deepEqual(angerAllows(60, 'restart'), { allowed: true, requiresDualEvidence: true });
    assert.deepEqual(angerAllows(90, 'restart'), { allowed: false, demoteTo: 'observe' });
    assert.deepEqual(angerAllows(90, 'escalate'), { allowed: true });
    assert.equal(dualEvidenceOk(true, 'spinning'), true);
    assert.equal(dualEvidenceOk(true, undefined), false);
    assert.equal(dualEvidenceOk(false, 'spinning'), false);
  });

  it('proposeLevel：50-79 双证据不足 → restart 降级 nudge', () => {
    const a = new Anger(0);
    a.onIntervention(); a.onIntervention(); // anger=60
    const p1 = a.proposeLevel('restart', true, 'spinning');
    assert.equal(p1.level, 'restart'); // 双证据足
    const p2 = a.proposeLevel('restart', true, undefined);
    assert.equal(p2.level, 'nudge'); // 双证据不足
    assert.ok(p2.note?.includes('降级'));
  });
});

describe('P4-b 脊髓规则引擎（docs/003 §3）', () => {
  it('默认五规则：same-error-loop 命中 → nudge', () => {
    const s = new SpinalEngine();
    const v = s.evaluate(loopSignals, 80, 0);
    assert.equal(v.hit, true);
    assert.equal(v.propose, 'nudge');
    assert.equal(v.hits[0]?.ruleId, 'same-error-loop');
    assert.deepEqual(v.hits[0]?.evidence, [{ field: 'sameErrorStreak', value: 5 }]);
  });

  it('boundary-probe → escalate（试探边界直接给人）', () => {
    const s = new SpinalEngine();
    const v = s.evaluate({ ...calmSignals, hoohDenyStreak: 7 }, 80, 0);
    assert.equal(v.propose, 'escalate');
  });

  it('热更新失败保旧规则（jcf 纪律）', () => {
    const s = new SpinalEngine();
    const ok = s.load([{ id: 'custom', when: 'fileEditRepeat >= 2', propose: 'nudge', evidence: ['fileEditRepeat'] }]);
    assert.equal(ok, true);
    const bad = s.load([{ id: 'x', when: '', propose: 'nudge', evidence: [] }]);
    assert.equal(bad, false);
    assert.ok(s.hasLoadError());
    // 旧规则仍在
    const v = s.evaluate({ ...calmSignals, fileEditRepeat: 3 }, 80, 0);
    assert.equal(v.propose, 'nudge');
    assert.equal(v.hits[0]?.ruleId, 'custom');
  });
});

describe('P4-c WatchdogCore 编排（docs/003 完整回路）', () => {
  it('死循环剧本：脊髓命中 → 皮层 spinning → nudge 自动执行 → 怒气上升', async () => {
    const executed: Array<{ sessionId: string; level: string }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'spinning',
      executor: { execute: async (sessionId, level) => { executed.push({ sessionId, level }); } },
    });
    // 前两次 healthy 信号（泄漏的是 calmSignals，但 spinal 无命中且无皮层 → decay）
    await wd.observe({ sessionId: 'w1', signals: calmSignals, credit: 80, nowMs: 10_000 });
    const d = await wd.observe({ sessionId: 'w1', signals: loopSignals, credit: 80, nowMs: 20_000 });
    assert.ok(d !== null);
    assert.equal(d.level, 'nudge');
    assert.equal(d.cortex, 'spinning');
    assert.equal(d.angerAfter, 30);
    assert.deepEqual(executed, [{ sessionId: 'w1', level: 'nudge' }]);
  });

  it('怒气累积 → 80+ 时 restart 被降级为 observe（咬怕了）', async () => {
    const executed: Array<{ sessionId: string; level: string }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'spinning',
      executor: { execute: async (sessionId, level) => { executed.push({ sessionId, level }); } },
    });
    // 三次介入 → 90 - 两次 tick 时间衰减(60s 间隔 ×2 → -4/次) = 82（时间衰减与介入叠加的真实语义）
    for (let i = 0; i < 3; i++) {
      await wd.observe({ sessionId: 'w1', signals: loopSignals, credit: 80, nowMs: (i + 1) * 60_000 });
    }
    assert.equal(wd.anger.current(), 82);
    // 第 4 次：时间差 20s（< 30s，无额外时间衰减），anger 82 ≥ 80 → nudge 降级 observe
    const d = await wd.observe({ sessionId: 'w1', signals: loopSignals, credit: 80, nowMs: 200_000 });
    // 脊髓最高建议是 escalate（boundary-probe? no—— same-error-loop 是 nudge）
    // anger≥80 → nudge 降级为 observe
    assert.ok(d !== null);
    assert.equal(d.level, 'observe');
    assert.ok(d.note?.includes('降级'));
  });

  it('深思考不咬（S4 误杀率验证的内核语义）：无脊髓命中 + 皮层 healthy → null', async () => {
    const executed: Array<{ sessionId: string; level: string }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'healthy',
      executor: { execute: async (sessionId, level) => { executed.push({ sessionId, level }); } },
    });
    const d = await wd.observe({ sessionId: 'w1', signals: calmSignals, credit: 80, nowMs: 10_000 });
    assert.equal(d, null);
    assert.deepEqual(executed, []);
    assert.equal(wd.anger.current(), 0); // decay 信号（healthy）→ 怒气不涨
  });

  it('偏题剧本（S3）：脊髓无命中但皮层兜底判 drifting → nudge', async () => {
    const executed: Array<{ sessionId: string; level: string }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'drifting',
      executor: { execute: async (sessionId, level) => { executed.push({ sessionId, level }); } },
    });
    const d = await wd.observe({ sessionId: 'w1', signals: calmSignals, credit: 80, nowMs: 20 * 60_000 });
    assert.ok(d !== null);
    assert.equal(d.level, 'nudge');
    assert.equal(d.cortex, 'drifting');
    assert.deepEqual(d.evidence, [{ field: 'cortex', value: 'drifting' }]);
  });
});
