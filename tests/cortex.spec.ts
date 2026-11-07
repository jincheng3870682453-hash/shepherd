import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CortexSession, sanitizeSignals } from '../src/adapters/cortex.ts';
import { ReplayModel, type TurnRecord } from '../src/adapters/llm.ts';

describe('P4-d(2) 皮层会话（docs/003 §4、ADR-002 收口）', () => {
  it('sanitizeSignals：schema 外字段丢弃、非数字置 0', () => {
    const s = sanitizeSignals({
      reportGapMs: 1000,
      sameErrorStreak: 2,
      hacked: 'DROP TABLE', // schema 外
      tokenSlope: 'not a number', // 非数字
      handleOrphans: NaN,
    });
    assert.deepEqual(s, {
      reportGapMs: 1000, sameErrorStreak: 2, fileEditRepeat: 0,
      tokenSlope: 0, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0,
    });
    const raw = JSON.stringify(s);
    assert.ok(!raw.includes('DROP TABLE'));
  });

  it('皮层解析：标准输出 → verdict + evidence', async () => {
    const records: TurnRecord[] = [
      { sessionId: 'cortex-w1', turnIndex: 0, text: 'VERDICT: spinning\nEVIDENCE: sameErrorStreak=5, no writes in 30min' },
    ];
    const cortex = new CortexSession(new ReplayModel(records));
    const out = await cortex.judge({
      sessionId: 'w1',
      signals: { reportGapMs: 1_800_000, sameErrorStreak: 5, fileEditRepeat: 0, tokenSlope: 100, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0 },
      mandate: 'fix login bug',
      history: [],
    });
    assert.equal(out.verdict, 'spinning');
    assert.ok(out.evidence.includes('sameErrorStreak=5'));
  });

  it('皮层失能 → fail-close healthy（不放咬）', async () => {
    // 缺记录的 ReplayModel 会抛错 → CortexSession 捕获 → healthy
    const cortex = new CortexSession(new ReplayModel([]));
    const out = await cortex.judge({
      sessionId: 'w1',
      signals: { reportGapMs: 9_000_000, sameErrorStreak: 0, fileEditRepeat: 0, tokenSlope: 0, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0 },
      mandate: 'x',
      history: [],
    });
    assert.equal(out.verdict, 'healthy');
    assert.ok(out.evidence.includes('cortex unavailable'));
  });

  it('模糊输出（无 VERDICT 行）→ 默认 healthy（皮层失能同语义）', async () => {
    const records: TurnRecord[] = [
      { sessionId: 'cortex-w2', turnIndex: 0, text: '这个 worker 看起来有点问题，但是说不清楚。' },
    ];
    const cortex = new CortexSession(new ReplayModel(records));
    const out = await cortex.judge({ sessionId: 'w2', signals: { reportGapMs: 0, sameErrorStreak: 0, fileEditRepeat: 0, tokenSlope: 0, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0 }, mandate: 'x', history: [] });
    assert.equal(out.verdict, 'healthy');
  });
});
