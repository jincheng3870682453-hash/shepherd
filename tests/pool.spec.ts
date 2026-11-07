import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPool, BenchmarkStats } from '../src/core/pool.ts';

describe('P2-d Worker 池并发（docs/002 §4）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-pool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('槽位上限：4 槽满后排队，释放自动弹队首并通知', () => {
    const pool = new WorkerPool(4);
    const freed: string[] = [];
    pool.onSlotFreed(s => freed.push(s.ticketId));
    for (let i = 1; i <= 6; i++) {
      const ok = pool.acquire({ ticketId: `t${i}`, sessionId: `w${i}` });
      if (i <= 4) assert.equal(ok, true);
      else assert.equal(ok, false); // 5、6 排队
    }
    assert.deepEqual(pool.stats(), { running: 4, queued: 2, maxSlots: 4 });
    const next = pool.release('t1');
    assert.equal(next?.ticketId, 't5'); // FIFO 弹出
    assert.deepEqual(freed, ['t5']);
    assert.equal(pool.release('nope'), null);
    pool.release('t2');
    assert.equal(pool.stats().running, 4); // t6 已顶上
    void dir;
  });

  it('BenchmarkStats：p50/p95/打扰/成本汇总', () => {
    const s = new BenchmarkStats();
    const rows: Array<[string, string, number, number | undefined, number, number]> = [
      ['t1', 'th1', 10, 20, 2, 0.5],
      ['t2', 'th2', 15, 45, 1, 0.2],
      ['t3', 'th3', 30, 60, 1, 0.3],
    ];
    for (const [id, th, a, d, it, c] of rows) {
      s.recordAccepted(id, th, a);
      for (let k = 0; k < it; k++) s.recordInterruption(id);
      if (d !== undefined) s.recordDelivered(id, d, c);
    }
    // 完成时间 deltas: [10, 30, 30] 排序 → p50 = idx 1 = 30
    assert.equal(s.percentile(50), 30);
    assert.equal(s.percentile(95), 30);
    assert.deepEqual(s.completionTimes().map(r => r.deltaSeq), [10, 30, 30]);
    const totals = s.totals();
    assert.equal(totals.delivered, 3);
    assert.equal(totals.interruptions, 4);
    assert.equal(totals.costUsd > 0, true);
    void dir;
  });
});
