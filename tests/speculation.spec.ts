import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpeculationScheduler } from '../src/core/speculation/scheduler.ts';
import { CreditEngine } from '../src/core/credit/tier.ts';
import { budgetFor } from '../src/core/credit/budget.ts';

function makeOp(id: string, credit: number): Parameters<SpeculationScheduler['propose']>[0] {
  return { opportunityId: id, sourceThread: `mock:th-${id}`, via: 'rule', trigger: 'bug-discussed', intent: `复现 ${id} 并找修复`, verifyHint: '复现脚本通过' };
}

describe('P5-d 投机调度器（docs/004 §3、旗舰二）', () => {
  it('预算三重门控：信用低→拒、并发满→拒、池干→静默', () => {
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 100_000, maxConcurrent: 2 }, 0);
    // 高信用源 → 接受
    const r1 = sched.propose(makeOp('op1', 100), 100);
    assert.equal(r1.accepted, true);
    const r2 = sched.propose(makeOp('op2', 100), 100);
    assert.equal(r2.accepted, true);
    // 并发满 → 拒
    const r3 = sched.propose(makeOp('op3', 100), 100);
    assert.equal(r3.accepted, false);
    assert.ok(r3.reason.includes('concurrency'));
    // 结算后释放
    sched.settle('op1', true, 10_000, 'verified');
    const r4 = sched.propose(makeOp('op4', 100), 100);
    assert.equal(r4.accepted, true);
  });

  it('低信用源：投机预算近零 → 拒绝（平方曲线，阈值 1000）', () => {
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 100_000, maxConcurrent: 2 }, 0);
    const r = sched.propose(makeOp('op-low', 10), 10); // credit 10 → budget 500 < 1000
    assert.equal(r.accepted, false);
    assert.ok(r.reason.includes('too low'));
  });

  it('池干涸 → 静默（永不挤占正式工作）', () => {
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 2_000, maxConcurrent: 10 }, 0);
    const r1 = sched.propose(makeOp('op-a', 100), 100); // budget 50k > pool 2k → reserve 2k
    assert.equal(r1.accepted, true);
    const r2 = sched.propose(makeOp('op-b', 100), 100); // pool 0 → dry
    assert.equal(r2.accepted, false);
    assert.ok(r2.reason.includes('pool dry'));
  });

  it('命中率仪表盘：delivered/dropped 统计 + would-do 日志', () => {
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 1_000_000, maxConcurrent: 10 }, 0);
    sched.propose(makeOp('op1', 100), 100);
    sched.propose(makeOp('op2', 100), 100);
    sched.propose(makeOp('op3', 100), 100);
    sched.settle('op1', true, 5_000, 'bait verified');
    sched.settle('op2', false, 8_000, 'no fix found');
    sched.settle('op3', false, 9_000, 'verify failed');
    const dash = sched.dashboard();
    assert.equal(dash.delivered, 1);
    assert.equal(dash.dropped, 2);
    assert.equal(dash.hitRate?.toFixed(2), '0.33');
    const log = sched.wouldDoLog();
    assert.equal(log.length, 2);
    assert.ok(log[0]!.intent.includes('复现'));
  });

  it('预算联动：结算未花完的回池', () => {
    const engine = new CreditEngine();
    const sched = new SpeculationScheduler(engine, { dailyPoolTokens: 60_000, maxConcurrent: 5 }, 0);
    sched.propose(makeOp('op1', 100), 100); // reserve 50k → pool 10k
    assert.equal(sched.dashboard().poolRemaining, 10_000);
    sched.settle('op1', true, 20_000, 'ok'); // 未花 30k 回池 → 40k
    assert.equal(sched.dashboard().poolRemaining, 40_000);
  });

  it('预算函数红线：投机预算 50k 平方曲线（credit 50 → 12.5k）', () => {
    assert.equal(budgetFor(50).speculationTokens, 12_500);
  });
});
