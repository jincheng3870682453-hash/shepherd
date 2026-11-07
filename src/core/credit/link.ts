/**
 * 信用总线联动（core/credit/link.ts）—— 脊髓/诱验器产 credit.changed 事件，
 * 预算函数进 Watchdog 脊髓与投机调度器的消费点（docs/004 §3-4）。
 *
 * 语义：CreditLink 把 CreditEngine 的落账包装成"事件草稿 + 视图更新"，
 * 调用方（apps 层）负责落总线。一处状态一个写者：信用=脊髓/诱验器写。
 */
import type { CreditEngine } from './tier.ts';
import type { CreditEventKind } from './tier.ts';
import type { EventDraft, EventId } from '../events.ts';

export interface CreditChange {
  readonly entity: string;
  readonly kind: CreditEventKind;
  readonly curAfter: number;
  readonly baseAfter: number;
  readonly delta: number;
}

export class CreditLink {
  private readonly engine: CreditEngine;

  constructor(engine: CreditEngine) {
    this.engine = engine;
  }

  /** 落账 + 产事件草稿（causedBy 指向触发它的证据事件——005 §1 铁律 2）。 */
  apply(entity: string, kind: import('./tier.ts').CreditEventKind, nowMs: number, causedBy: EventId): { change: CreditChange; draft: EventDraft<'credit.changed'> } {
    const r = this.engine.applyEvent(entity, kind, nowMs);
    const change: CreditChange = { entity, kind, curAfter: r.cur, baseAfter: r.base, delta: r.delta };
    const draft = this.engine.draftCreditChanged(entity, r.cur, r.base, r.delta, `credit_${entity}_${nowMs}`, causedBy);
    return { change, draft };
  }

  engineRef(): CreditEngine {
    return this.engine;
  }
}
