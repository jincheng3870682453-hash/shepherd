/**
 * SQLite 事件存储（adapters 层；Node 24 内置 node:sqlite，零第三方依赖）。
 *
 * 表结构（docs/002 §2）：
 *   events(seq PK, id UNIQUE, type, ts, ingested_at, producer, caused_by, payload, audit_hash)
 *   natural_keys(key PK, event_id)      —— 幂等去重
 *   meta(k PK, v)                       —— 链头
 *
 * 运行时约束：以 Node strip-types 直接运行（无代码生成），禁用参数属性等语法；
 * 事务用显式 BEGIN IMMEDIATE/COMMIT/ROLLBACK（node:sqlite 无 .begin() API）。
 *
 * 职责划分：core.Bus = 语义（校验/封缄/哈希），SqliteBus = 原子写入（判定与落盘一个事务窗口）。
 */
import { DatabaseSync } from 'node:sqlite';
import { chainHash, genesisHash, type AuditKey } from '../core/audit.ts';
import type { EventDraft, EventId, EventType } from '../core/events.ts';
import { Bus, EventRejected, type BusHost, type StoredEvent } from '../core/bus.ts';

export class SqliteStore implements BusHost {
  private readonly db: DatabaseSync;
  private readonly key: AuditKey;
  private cachedHead: string | null = null;

  constructor(dbPath: string, auditKey: AuditKey) {
    this.key = auditKey;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        producer TEXT NOT NULL,
        caused_by TEXT,
        payload TEXT NOT NULL,
        audit_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS natural_keys (
        key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id)
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // ── BusHost 端口 ──────────────────────────────────────────────────

  now(): string {
    return new Date().toISOString();
  }

  nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events').get() as
      | { next: number }
      | undefined;
    return row?.next ?? 0;
  }

  auditKey(): AuditKey {
    return this.key;
  }

  headHash(): string {
    if (this.cachedHead !== null) return this.cachedHead;
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('head') as { v: string } | undefined;
    // 空库的链头 = genesis 哈希（与 verifyChain 的起点一致，首事件才不会假断链）
    this.cachedHead = row?.v ?? genesisHash(this.key);
    return this.cachedHead;
  }

  findNaturalKey(key: string): EventId | null {
    const row = this.db.prepare('SELECT event_id FROM natural_keys WHERE key = ?').get(key) as
      | { event_id: string }
      | undefined;
    return row?.event_id ?? null;
  }

  putNaturalKey(key: string, id: EventId): void {
    this.db.prepare('INSERT INTO natural_keys (key, event_id) VALUES (?, ?)').run(key, id);
  }

  // ── 写入与读取 ────────────────────────────────────────────────────

  /**
   * 原子追加：事件行 + 自然键 + 链头在同一 BEGIN IMMEDIATE 事务里。
   * 调用方（SqliteBus）已通过 BusHost 端口完成判定；本方法只做幂等兜底（PK 冲突即抛）。
   */
  insert(stored: StoredEvent, naturalKey?: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO events (seq, id, type, ts, ingested_at, producer, caused_by, payload, audit_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          stored.seq,
          stored.id,
          stored.type,
          stored.ts,
          stored.ingestedAt,
          stored.producer,
          stored.causedBy,
          JSON.stringify(stored.payload),
          stored.auditHash,
        );
      if (naturalKey !== undefined) {
        this.putNaturalKey(naturalKey, stored.id);
      }
      this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('head', stored.auditHash);
      this.db.exec('COMMIT');
      this.cachedHead = stored.auditHash;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 按序读取全部事件（重放/校验用）。 */
  allEvents(): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, id, type, ts, ingested_at, producer, caused_by, payload, audit_hash FROM events ORDER BY seq')
      .all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      seq: r['seq'] as number,
      id: r['id'] as string,
      type: r['type'] as EventType,
      ts: r['ts'] as string,
      ingestedAt: r['ingested_at'] as string,
      producer: r['producer'] as string,
      causedBy: (r['caused_by'] as string | null) ?? null,
      payload: JSON.parse(r['payload'] as string),
      auditHash: r['audit_hash'] as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 组装好的总线。append 的原子窗口：
 *   BEGIN → 封缄（Bus 语义，含幂等查询）→ 事件行 → 自然键 → 链头 → COMMIT
 * 事务内任何一步失败整体 ROLLBACK。
 */
export class SqliteBus {
  readonly bus: Bus;
  readonly store: SqliteStore;
  readonly root: Bus['root'];
  readonly child: Bus['child'];
  readonly verifyChain: Bus['verifyChain'];
  readonly allEvents: () => StoredEvent[];
  readonly close: () => void;

  constructor(dbPath: string, auditKey: AuditKey) {
    this.store = new SqliteStore(dbPath, auditKey);
    this.bus = new Bus(this.store);
    this.root = this.bus.root.bind(this.bus);
    this.child = this.bus.child.bind(this.bus);
    this.verifyChain = this.bus.verifyChain.bind(this.bus);
    this.allEvents = this.store.allEvents.bind(this.store);
    this.close = this.store.close.bind(this.store);
  }

  append(draft: EventDraft, naturalKey?: string): { kind: 'stored'; event: StoredEvent } | { kind: 'duplicate'; canonicalId: EventId; naturalKey: string } {
    // 预检（事务外快速失败，错误信息与 Bus.seal 一致）
    const pre = draft as unknown as { causedBy?: unknown; auditHash?: unknown; id?: string };
    if (pre.causedBy === undefined) {
      throw new EventRejected('missing_caused_by', `事件 ${String(pre.id ?? '(无 id)')} 未声明 causedBy（根事件须显式 null）`);
    }
    if (pre.auditHash !== undefined && pre.auditHash !== null) {
      throw new EventRejected('bad_audit_hash', '调用方不允许自带 auditHash（由总线计算）');
    }
    if (naturalKey !== undefined) {
      const existing = this.store.findNaturalKey(naturalKey);
      if (existing !== null) return { kind: 'duplicate', canonicalId: existing, naturalKey };
    }
    const seq = this.store.nextSeq();
    // Bus.append 在此仅用于封缄（幂等已在上面查过，传 undefined 避免重复记键）
    const result = this.bus.append(draft, undefined);
    if (result.kind !== 'stored') throw new EventRejected('bad_draft', '封缄返回异常状态');
    this.store.insert(result.event, naturalKey);
    return { kind: 'stored', event: result.event };
  }
}

export type { Bus, BusHost, StoredEvent };
