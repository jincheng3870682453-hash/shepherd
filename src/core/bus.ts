/**
 * 总线核心语义（纯逻辑，无 I/O）—— docs/002 §2、docs/005 §1。
 *
 * 事务性由 Store 保证：Bus 决定"记什么、链怎么串、幂等键怎么判"，Store 决定"怎么落盘"。
 * 注意：本代码以 Node --experimental-strip-types 直接运行（node:test），禁用参数属性等
 * 需要代码生成的 TS 语法（docs/910-conventions.md §6）。
 */
import type { EventDraft, EventEnvelope, EventType, EventId, Producer } from './events.ts';
import { chainHash, genesisHash, looksLikeHash, type AuditKey } from './audit.ts';

export type { AuditKey };

/** 入库事件：信封 + 审计哈希（总线分配 seq 后计算）。 */
export type StoredEvent<T extends EventType = EventType> = EventEnvelope<T> & {
  readonly auditHash: string;
};

export type AppendResult =
  | { readonly kind: 'stored'; readonly event: StoredEvent }
  | { readonly kind: 'duplicate'; readonly canonicalId: EventId; readonly naturalKey: string };

/** 事件校验失败：违反三条铁律之一（005 §1）。 */
export class EventRejected extends Error {
  code: 'missing_caused_by' | 'bad_audit_hash' | 'bad_draft';

  constructor(code: 'missing_caused_by' | 'bad_audit_hash' | 'bad_draft', message: string) {
    super(`[${code}] ${message}`);
    this.name = 'EventRejected';
    this.code = code;
  }
}

export interface BusHost {
  now(): string;
  nextSeq(): number;
  auditKey(): AuditKey;
  /** 查询自然键是否已存在；返回其 canonical id 或 null。 */
  findNaturalKey(key: string): EventId | null;
  /** 记录新自然键 → canonical id（在 Store 的同一事务里调用）。 */
  putNaturalKey(key: string, id: EventId): void;
  /** 最后一条已入库事件的审计哈希（链头）。 */
  headHash(): string;
}

/** 供 seal 使用的宽松草稿形状（JS 调用方可能漏 causedBy，运行时仍要拦）。 */
type LooseDraft = EventDraft & { readonly causedBy?: EventId | null; readonly auditHash?: unknown };

/** 校验 + 定 seq + 算链哈希 + 幂等判定。全部同步；落盘交给 host 的调用方。 */
export class Bus {
  private readonly host: BusHost;

  constructor(host: BusHost) {
    this.host = host;
  }

  append(draft: EventDraft, naturalKey?: string): AppendResult {
    const seq = this.host.nextSeq();
    const stored = this.seal(draft, seq);
    if (naturalKey !== undefined) {
      const existing = this.host.findNaturalKey(naturalKey);
      if (existing !== null) {
        return { kind: 'duplicate', canonicalId: existing, naturalKey };
      }
      this.host.putNaturalKey(naturalKey, stored.id);
    }
    return { kind: 'stored', event: stored };
  }

  private seal(draft: EventDraft, seq: number): StoredEvent {
    const loose = draft as LooseDraft;
    if (loose.causedBy === undefined) {
      throw new EventRejected('missing_caused_by', `事件 ${String(loose.id ?? '(无 id)')} 未声明 causedBy（根事件须显式 null）`);
    }
    if (loose.auditHash !== undefined && loose.auditHash !== null) {
      throw new EventRejected('bad_audit_hash', '调用方不允许自带 auditHash（由总线计算）');
    }
    const envelope = { ...loose, seq } as unknown as StoredEvent;
    const hash = chainHash(this.host.headHash(), envelope, this.host.auditKey());
    return Object.freeze({ ...envelope, auditHash: hash });
  }

  /** 全链校验：重放路径使用（005 §4）。 */
  verifyChain(events: readonly StoredEvent[], key: AuditKey): { ok: boolean; brokenAtSeq?: number } {
    let prev = genesisHash(key);
    for (const e of events) {
      if (!looksLikeHash(e.auditHash)) return { ok: false, brokenAtSeq: e.seq };
      const { auditHash, ...rest } = e;
      void auditHash;
      const expect = chainHash(prev, rest, key);
      if (expect !== auditHash) return { ok: false, brokenAtSeq: e.seq };
      prev = auditHash;
    }
    return { ok: true };
  }

  /** 便捷构造：根事件（显式声明无因果父）。 */
  root<T extends EventType>(type: T, producer: Producer, payload: unknown, id: EventId): EventDraft<T> {
    return { id, type, ts: this.host.now(), ingestedAt: this.host.now(), producer, causedBy: null, payload } as unknown as EventDraft<T>;
  }

  /** 便捷构造：因果事件。 */
  child<T extends EventType>(type: T, producer: Producer, payload: unknown, id: EventId, causedBy: EventId): EventDraft<T> {
    return { id, type, ts: this.host.now(), ingestedAt: this.host.now(), producer, causedBy, payload } as unknown as EventDraft<T>;
  }
}
