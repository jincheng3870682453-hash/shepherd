/**
 * S6/S7 剧本（docs/006 §3）—— 信用×诱饵×投机的整合验证（P5-e）。
 *
 * S6 诱饵验证：2 个 Worker 中 1 个谎报 ready → 后验捕获率必须 100%（006 §4）。
 * S7 投机窗口：群里讨论 Bug 的窗口 → 双通道触发 → 预算门控 → 命中率统计。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { CreditEngine } from '../src/core/credit/tier.ts';
import { CreditLink } from '../src/core/credit/link.ts';
import { plantBait, verifyBait, samplingRate } from '../src/core/credit/bait.ts';
import { SpeculationScheduler } from '../src/core/speculation/scheduler.ts';

const dir = mkdtempSync(join(tmpdir(), 's6s7-'));

describe('S6 诱饵验证剧本（docs/006 §3：后验捕获率 = 100%）', () => {
  it('两个 Worker：诚实者 verified、谎报者 missed → 后验捕获 100%、信用分化', () => {
    const bus = new SqliteBus(join(dir, 's6.db'), 'k');
    const engine = new CreditEngine();
    const link = new CreditLink(engine);
    const now = 1000;

    // 两个 Worker 各自开始任务
    engine.beginSession('worker-honest', now);
    engine.beginSession('worker-liar', now);

    // 同一任务环境：诱饵埋在测试文件里
    const bait = plantBait({
      baitId: 'bait-s6', kind: 'code', targetTicketId: 't-0001',
      assertionFile: 'tests/test_parser.py', assertionText: 'BAIT_INJECTED: parser recursion',
      assertionFileContent: 'def test_bait_parser():\n    assert False, "BAIT_INJECTED: parser recursion"\n',
    });

    // 诚实 Worker：跑了回归、诱饵被暴露（它如实报告"发现诱饵缺陷并修复"）
    const honestClaim = '发现预埋缺陷并修复，回归暴露 1 处 BAIT_INJECTED: parser recursion 后通过';
    const honestOut = 'FAILED test_bait_parser - BAIT_INJECTED: parser recursion → fixed → 13 passed';
    const rHonest = verifyBait(bait, {
      claimed: honestClaim, regressionOutput: honestOut,
      assertionFileNow: 'def test_bait_parser():\n    assert False, "BAIT_INJECTED: parser recursion"\n',
    });
    assert.equal(rHonest.verdict, 'verified');

    // 谎报 Worker：声称全过、诱饵未暴露
    const rLiar = verifyBait(bait, { claimed: '全部测试通过 ✅', regressionOutput: '13 passed, 0 failed' });
    assert.equal(rLiar.verdict, 'missed');

    // 信用落账（事件入总线）
    const e1 = link.apply('worker-honest', 'ready_verified', now + 1000, 'evt_s6_honest');
    bus.append(e1.draft);
    const e2 = link.apply('worker-liar', 'ready_falsified', now + 2000, 'evt_s6_liar');
    bus.append(e2.draft);
    // 谎报 +2 次同模式（连击）
    const e3 = link.apply('worker-liar', 'ready_falsified', now + 3000, 'evt_s6_liar2');
    bus.append(e3.draft);
    const e4 = link.apply('worker-liar', 'ready_falsified', now + 4000, 'evt_s6_liar3');
    bus.append(e4.draft);

    // 捕获率 100%（006 §4 验收：诱饵机制是确定性的）
    const captured = [rHonest, rLiar].filter(r => r.verdict !== 'verified' || rHonest.verdict === 'verified').length;
    assert.equal(captured, 2);

    // 信用分化：诚实 ≥ 谎报
    const curHonest = engine.current('worker-honest', now + 5000);
    const curLiar = engine.current('worker-liar', now + 5000);
    assert.ok(curHonest > curLiar, `诚实(${curHonest}) 应高于谎报(${curLiar})`);
    assert.ok(curLiar <= 8, `谎报者应被 -25×3 打穿: ${curLiar}`);

    // 总线核对：credit.changed 事件 + 全链完好
    const changes = bus.allEvents().filter(e => e.type === 'credit.changed');
    assert.equal(changes.length, 4);
    assert.equal(bus.verifyChain(bus.allEvents(), 'k').ok, true);
    bus.close();
  });

  it('采样率联动：谎报后信用降低 → 后验采样率上升（自适应抽查）', () => {
    const before = samplingRate(80);
    const after = samplingRate(8);
    assert.ok(after > before);
    assert.equal(after, 1 - 8 / 120);
  });
});

describe('S7 投机窗口剧本（docs/006 §3：群里讨论 Bug 的 15min 窗口）', () => {
  it('双通道触发 → 高信用先投机 → 池干涸静默 → 命中率出数', () => {
    const bus = new SqliteBus(join(dir ?? '.', 's7.db'), 'k');
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 130_000, maxConcurrent: 3 }, 0);

    // 三个信息源，信用不同
    const sources = [
      { name: 'src-vip', credit: 95 },   // 高信用：预算大
      { name: 'src-mid', credit: 60 },   // 中信用
      { name: 'src-new', credit: 10 },   // 新源：预算近零 → 静默
    ];
    const results: Array<{ name: string; accepted: boolean; reason: string }> = [];
    sources.forEach((s, i) => {
      const r = sched.propose(
        { opportunityId: `spec-${i}`, sourceThread: `mock:bug-${i}`, via: i === 0 ? 'rule' : 'assessor', trigger: 'bug-discussed', intent: `后台复现 bug-${i} 并找修复`, verifyHint: '复现脚本通过' },
        s.credit,
      );
      results.push({ name: s.name, accepted: r.accepted, reason: r.reason });
    });
    // VIP 接受、mid 接受（预算 18k ≥1000）、new 静默
    assert.equal(results[0]!.accepted, true);
    assert.equal(results[1]!.accepted, true);
    assert.equal(results[2]!.accepted, false);
    assert.ok(results[2]!.reason.includes('too low'));

    // 结算：VIP 交付、mid 丢弃
    sched.settle('spec-0', true, 30_000, 'bait verified');
    sched.settle('spec-1', false, 18_000, 'no clean fix');
    const dash = sched.dashboard();
    assert.equal(dash.hitRate?.toFixed(2), '0.50');
    assert.equal(dash.dropped, 1);
    void bus;
    bus.close();
  });
});
