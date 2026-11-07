import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryCollector, BaselineTracker } from '../src/core/watchdog/telemetry.ts';
import { WatchdogCore } from '../src/core/watchdog/core.ts';
import { SpinalEngine } from '../src/core/watchdog/spinal.ts';
import type { TelemetryObservation } from '../src/core/watchdog/telemetry.ts';
import type { InterventionLevel } from '../src/core/watchdog/anger.ts';

describe('P4-d 遥测采集（docs/003 §2 七信号）', () => {
  it('实质报告间隔：读类成功不重置、写类成功重置（HooH STALL 规则）', () => {
    const c = new TelemetryCollector(0);
    const s1 = c.observe({ nowMs: 60_000, tools: [{ tool: 'file_read', ok: true, writes: false }], editedFiles: [], tokensUsed: 100, handleOrphans: 0 }, 0);
    assert.equal(s1.reportGapMs, 60_000); // 读类不算实质
    const s2 = c.observe({ nowMs: 120_000, tools: [{ tool: 'file_write', ok: true, writes: true }], editedFiles: ['a.ts'], tokensUsed: 100, handleOrphans: 0 }, 0);
    assert.equal(s2.reportGapMs, 0); // 写类成功 → 重置
  });

  it('连续相同错误计数：同错累加、异错重置', () => {
    const c = new TelemetryCollector(0);
    c.observe({ nowMs: 1000, tools: [{ tool: 'cmd', ok: false, writes: false }], editedFiles: [], tokensUsed: 10, handleOrphans: 0 }, 0);
    const s2 = c.observe({ nowMs: 2000, tools: [{ tool: 'cmd', ok: false, writes: false }], editedFiles: [], tokensUsed: 10, handleOrphans: 0 }, 0);
    assert.equal(s2.sameErrorStreak, 2);
    const s3 = c.observe({ nowMs: 3000, tools: [{ tool: 'net', ok: false, writes: false }], editedFiles: [], tokensUsed: 10, handleOrphans: 0 }, 0);
    assert.equal(s3.sameErrorStreak, 1); // 异错重置
  });

  it('同文件往返编辑：第 2 次起 fileEditRepeat 递增', () => {
    const c = new TelemetryCollector(0);
    c.observe({ nowMs: 1000, tools: [{ tool: 'str_replace', ok: true, writes: true }], editedFiles: ['a.ts'], tokensUsed: 10, handleOrphans: 0 }, 0);
    const s2 = c.observe({ nowMs: 2000, tools: [{ tool: 'str_replace', ok: true, writes: true }], editedFiles: ['a.ts'], tokensUsed: 10, handleOrphans: 0 }, 0);
    assert.equal(s2.fileEditRepeat, 1);
    const s3 = c.observe({ nowMs: 3000, tools: [{ tool: 'str_replace', ok: true, writes: true }], editedFiles: ['a.ts'], tokensUsed: 10, handleOrphans: 0 }, 0);
    assert.equal(s3.fileEditRepeat, 2);
  });

  it('空转思考：零工具轮连续计数、有工具轮清零', () => {
    const c = new TelemetryCollector(0);
    c.observe({ nowMs: 1000, tools: [], editedFiles: [], tokensUsed: 50, handleOrphans: 0 }, 0);
    const s2 = c.observe({ nowMs: 2000, tools: [], editedFiles: [], tokensUsed: 50, handleOrphans: 0 }, 0);
    assert.equal(s2.turnNoToolStreak, 2);
    const s3 = c.observe({ nowMs: 3000, tools: [{ tool: 'file_read', ok: true, writes: false }], editedFiles: [], tokensUsed: 50, handleOrphans: 0 }, 0);
    assert.equal(s3.turnNoToolStreak, 0);
  });

  it('基线跟踪：前 10 个样本的均值（tokenSlope 3x 判据）', () => {
    const b = new BaselineTracker();
    for (let i = 0; i < 10; i++) b.push(100);
    assert.equal(b.current(), 100);
  });
});

describe('P4-d 端到端：死循环故障注入 → Watchdog 自动介入（S2 剧本内核版）', () => {
  it('相同错误刷屏 3 次 → 脊髓命中 → nudge 自动投递', async () => {
    const collector = new TelemetryCollector(0);
    const executed: Array<{ sessionId: string; level: InterventionLevel; evidence: ReadonlyArray<{ field: string; value: unknown }> }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'spinning',
      executor: { execute: async (sessionId, level, evidence) => { executed.push({ sessionId, level, evidence }); } },
    });
    // 5 轮观察：每轮 cmd 失败（同错）、无写、无实质报告
    for (let i = 0; i < 5; i++) {
      const nowMs = (i + 1) * 30_000;
      const signals = collector.observe(
        { nowMs, tools: [{ tool: 'cmd', ok: false, writes: false }], editedFiles: [], tokensUsed: 500, handleOrphans: 0 },
        0,
      );
      const d = await wd.observe({ sessionId: 'w-loop', signals, credit: 80, nowMs });
      if (i === 2) {
        // 第 3 轮：sameErrorStreak=3 → same-error-loop 命中
        assert.ok(d !== null);
        assert.equal(d.level, 'nudge');
        assert.equal(d.angerAfter, 30);
      }
    }
    assert.ok(executed.length >= 1, '至少一次 nudge 已执行');
    assert.equal(executed[0]!.level, 'nudge');
  });

  it('burn-rate：token 斜率 3x 且无孤儿句柄 → nudge', async () => {
    const s = new SpinalEngine();
    // 手动构造信号：tokenSlope 高、handleOrphans 0
    const v = s.evaluate(
      { reportGapMs: 10_000, sameErrorStreak: 0, fileEditRepeat: 0, tokenSlope: 900, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0 },
      80, 0,
    );
    // burn-rate 条件 tokenSlope > 3（mock 中基线≈1，斜率 900 远超）——但默认规则的
    // 字段单位是斜率比值还是绝对值？003 §3 写 "tokenSlope > 3x baseline"，
    // 实现为绝对值阈值（基线折算由调用方做）——此处验证规则命中
    assert.equal(v.propose, 'nudge');
    assert.ok(v.hits.some(h => h.ruleId === 'burn-rate'));
  });

  it('Watchdog 全链路（遥测→脊髓→皮层→怒气→执行）事件语义完整', async () => {
    const collector = new TelemetryCollector(0);
    const executed: Array<{ level: InterventionLevel }> = [];
    const wd = new WatchdogCore({
      nowMs: 0,
      cortexJudge: async () => 'spinning',
      executor: { execute: async (_s, level) => { executed.push({ level }); } },
    });
    // 循环故障 4 轮
    for (let i = 0; i < 4; i++) {
      const nowMs = (i + 1) * 30_000;
      const signals = collector.observe({ nowMs, tools: [{ tool: 'cmd', ok: false, writes: false }], editedFiles: [], tokensUsed: 500, handleOrphans: 0 }, 0);
      await wd.observe({ sessionId: 'w2', signals, credit: 80, nowMs });
    }
    // 第 3 轮起 nudge 执行（同错 3 命中），第 4 轮 anger 56 → 仍 nudge
    assert.equal(executed.filter(e => e.level === 'nudge').length, 2);
    assert.equal(wd.anger.current() >= 50, true, '两次介入后怒气应过 50');
  });
});
