import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventDraft, EventOf } from '../src/core/events.ts';

// 测试运行器：Node 内置 test runner（零第三方测试依赖）。
// 沙盒内 esbuild/vite 的管道子进程受限（EPERM），故不使用 vitest —— docs/910-conventions.md。

describe('005 §1 事件信封（类型级验证）', () => {
  it('根事件显式 causedBy=null，因果事件必须指向父 id', () => {
    const root: EventDraft<'source.trigger.received'> = {
      id: 'evt_01ROOT',
      type: 'source.trigger.received',
      ts: '2026-11-07T15:04:05.123Z',
      ingestedAt: '2026-11-07T15:04:05.200Z',
      producer: 'mock-gen',
      causedBy: null,
      payload: { naturalKey: 'mock:s1:m1', thread: 'mock:topic-1', kind: 'mock' },
    };
    const child: EventDraft<'intake.accepted'> = {
      id: 'evt_01CHILD',
      type: 'intake.accepted',
      ts: root.ts,
      ingestedAt: root.ingestedAt,
      producer: 'intake',
      causedBy: root.id,
      payload: {},
    };
    assert.equal(root.causedBy, null);
    assert.equal(child.causedBy, root.id);
  });

  it('watchdog.intervened 载荷必须带 evidence（003 §1 不变式 4）', () => {
    const evt: EventOf<'watchdog.intervened'>['payload'] = {
      sessionId: 'worker-ticket-17',
      level: 'nudge',
      evidence: ['same-error-loop'],
      angerAfter: 30,
    };
    assert.ok(evt.evidence.length > 0);
  });

  it('hooh.decided 的 decision 是闭合枚举', () => {
    const decisions = ['allow', 'deny', 'sandboxed', 'asked'] as const;
    const evt: EventOf<'hooh.decided'>['payload'] = {
      sessionId: 's1',
      tool: 'file_write',
      decision: 'deny',
      reason: 'sensitive target',
    };
    assert.ok((decisions as readonly string[]).includes(evt.decision));
  });
});
