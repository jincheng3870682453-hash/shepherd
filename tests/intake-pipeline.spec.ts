import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBus } from '../src/adapters/store.ts';
import { Orchestrator, type Assessor } from '../src/core/orchestrator.ts';

/** 全接受评估器（只看过滤管线行为）。 */
const acceptAll: Assessor = input => ({ accept: true, mandate: input.text.slice(0, 80) });

describe('P3-d 入口管线接线（docs/005 §3：rule_gate → ambiguity → assess）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-pipe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rule_gate BLOCK（命中自定义规则）→ filtered{stage: rule_gate}，不产 Ticket', () => {
    const bus = new SqliteBus(join(dir, 'a.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: acceptAll });
    orch.ruleGate.load({ rules: [{ id: 'no-spam', action: 'BLOCK', pattern: 'SPAM', reason: 'spam detected', logLevel: 'warn' }], settings: {} });
    const r = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 't1', kind: 'mock', text: 'buy SPAM now' }, 'trg1'), 'k1');
    assert.ok(r.kind === 'stored');
    const ticket = orch.onTrigger(r.event.seq, r.event.id, 't1', 'mock', 'buy SPAM now');
    assert.equal(ticket, null);
    const filtered = bus.allEvents().filter(e => e.type === 'intake.filtered');
    assert.equal(filtered.length, 1);
    assert.equal((filtered[0]!.payload as { stage: string }).stage, 'rule_gate');
    bus.close();
  });

  it('ambiguity GIBBERISH → filtered{stage: ambiguity}；HIGH → clarify 不受理', () => {
    const bus = new SqliteBus(join(dir, 'b.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: acceptAll });
    const r1 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 't1', kind: 'mock', text: '@@@ ### !!!' }, 'trg1'), 'k1');
    assert.ok(r1.kind === 'stored');
    const t1 = orch.onTrigger(r1.event.seq, r1.event.id, 't1', 'mock', '@@@ ### !!!');
    assert.equal(t1, null);
    const r2 = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 't2', kind: 'mock', text: '登录' }, 'trg2'), 'k2');
    assert.ok(r2.kind === 'stored');
    const t2 = orch.onTrigger(r2.event.seq, r2.event.id, 't2', 'mock', '登录');
    assert.equal(t2, null);
    const verdict = orch.intake('evt_x', '登录');
    assert.equal(verdict.action, 'clarify');
    assert.ok(verdict.action === 'clarify' && verdict.prompt.length > 0);
    bus.close();
  });

  it('结构化源旁路：模糊短文本的 GitHub Issue 直接进受理（github_scout 语义）', () => {
    const bus = new SqliteBus(join(dir, 'c.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: acceptAll });
    const r = bus.append(bus.root('source.trigger.received', 'github:o/r', { thread: 'gh:o/r#1', kind: 'issue', text: 'login broken' }, 'trg1'), 'k1');
    assert.ok(r.kind === 'stored');
    const ticket = orch.onTrigger(r.event.seq, r.event.id, 'gh:o/r#1', 'issue', 'login broken', true);
    assert.ok(ticket !== null, '结构化源不应被模糊分流拦截');
    bus.close();
  });

  it('TRUNCATE：超长输入截断后进慢路径，Ticket 拿到截断 mandate', () => {
    const bus = new SqliteBus(join(dir, 'd.db'), 'k');
    const orch = new Orchestrator(bus, { assessor: acceptAll });
    orch.ruleGate.load({ rules: [{ id: 'cap', action: 'TRUNCATE', condition: 'length > 50', reason: 'too long', logLevel: 'info', truncate_to: 50 }], settings: {} });
    const long = '这是一个很长的输入'.repeat(20);
    const r = bus.append(bus.root('source.trigger.received', 'mock-gen', { thread: 't1', kind: 'mock', text: long }, 'trg1'), 'k1');
    assert.ok(r.kind === 'stored');
    const ticket = orch.onTrigger(r.event.seq, r.event.id, 't1', 'mock', long, true);
    assert.ok(ticket !== null);
    assert.ok(orch.view.byId.get(ticket)!.mandate.length <= 50);
    bus.close();
  });
});
