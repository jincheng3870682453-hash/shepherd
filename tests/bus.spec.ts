import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { EventRejected } from '../src/core/bus.ts';

const KEY = 'test-audit-key';

describe('P1 事件总线（docs/002 §2、docs/005 §1）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-bus-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('追加写：seq 单调、链头推进、可读回', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    const r1 = b.append(b.root('source.trigger.received', 'mock-gen', { n: 1 }, 'evt_1'), 'mock:s1:m1');
    const r2 = b.append(b.child('intake.accepted', 'intake', {}, 'evt_2', 'evt_1'));
    assert.equal(r1.kind, 'stored');
    assert.equal(r2.kind, 'stored');
    if (r1.kind === 'stored' && r2.kind === 'stored') {
      assert.equal(r1.event.seq, 0);
      assert.equal(r2.event.seq, 1);
      assert.notEqual(r2.event.auditHash, r1.event.auditHash);
    }
    assert.deepEqual(b.allEvents().map(e => e.seq), [0, 1]);
    b.close();
  });

  it('幂等：同自然键重复到达 → duplicate，不入流（005 §1 铁律 1）', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    const first = b.append(b.root('source.trigger.received', 'mock-gen', { n: 1 }, 'evt_1'), 'gh:repo#42:comment:1');
    const again = b.append(b.root('source.trigger.received', 'mock-gen', { n: 1 }, 'evt_1x'), 'gh:repo#42:comment:1');
    assert.equal(first.kind, 'stored');
    assert.equal(again.kind, 'duplicate');
    if (again.kind === 'duplicate') assert.equal(again.canonicalId, 'evt_1');
    assert.equal(b.allEvents().length, 1);
    b.close();
  });

  it('因果铁律：缺 causedBy 直接拒绝（005 §1 铁律 2）', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    const bad = { id: 'evt_bad', type: 'intake.accepted', ts: 't', ingestedAt: 't', producer: 'x', payload: {} };
    assert.throws(
      () => b.append(bad as never),
      (e: unknown) => e instanceof EventRejected && e.code === 'missing_caused_by',
    );
    assert.equal(b.allEvents().length, 0);
    b.close();
  });

  it('调用方不可自带 auditHash', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    const bad = { id: 'evt_h', type: 'intake.accepted', ts: 't', ingestedAt: 't', producer: 'x', causedBy: null, payload: {}, auditHash: 'hmac:fake' };
    assert.throws(
      () => b.append(bad as never),
      (e: unknown) => e instanceof EventRejected && e.code === 'bad_audit_hash',
    );
    b.close();
  });

  it('审计链：篡改历史事件 → verifyChain 在断点报告（910 §4）', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    b.append(b.root('source.trigger.received', 'mock-gen', { n: 1 }, 'evt_1'), 'k1');
    b.append(b.child('intake.accepted', 'intake', {}, 'evt_2', 'evt_1'));
    b.append(b.child('ticket.opened', 'router', { ticketId: 't1' }, 'evt_3', 'evt_2'));
    const all = b.allEvents();
    assert.deepEqual(b.verifyChain(all, KEY), { ok: true });

    const tampered = all.map(e => (e.id === 'evt_2' ? { ...e, payload: { hacked: true } } : e));
    const verdict = b.verifyChain(tampered, KEY);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.brokenAtSeq, 1);
    b.close();
  });

  it('重放一致性：关闭重开 → 链头延续、全链验证通过（005 §4）', () => {
    const path = join(dir, 'ev.db');
    {
      const b = new SqliteBus(path, KEY);
      b.append(b.root('source.trigger.received', 'mock-gen', { n: 1 }, 'evt_1'), 'k1');
      b.close();
    }
    {
      const b = new SqliteBus(path, KEY);
      const r = b.append(b.child('intake.accepted', 'intake', {}, 'evt_2', 'evt_1'));
      assert.equal(r.kind, 'stored');
      if (r.kind === 'stored') assert.equal(r.event.seq, 1);
      assert.equal(b.verifyChain(b.allEvents(), KEY).ok, true);
      b.close();
    }
  });

  it('高频追加：500 事件压测下 seq 连续、全链完好', () => {
    const b = new SqliteBus(join(dir, 'ev.db'), KEY);
    for (let i = 0; i < 500; i++) {
      const parent = i === 0 ? null : `evt_m${i - 1}`;
      const draft = parent === null
        ? b.root('meter.charge', 'meter', { i }, `evt_m${i}`)
        : b.child('meter.charge', 'meter', { i }, `evt_m${i}`, parent);
      const r = b.append(draft);
      if (r.kind !== 'stored') throw new Error(`事件 ${i} 未入库`);
    }
    const all = b.allEvents();
    assert.equal(all.length, 500);
    const last = all[499];
    assert.ok(last !== undefined);
    assert.equal(last.seq, 499);
    assert.equal(b.verifyChain(all, KEY).ok, true);
    b.close();
  });
});
