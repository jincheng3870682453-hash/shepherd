/**
 * Ticket 物化视图 —— 从总线事件重建（core，零 I/O）。
 *
 * 一处状态一个写者：Ticket 状态只由 Orchestrator 写事件，本视图只读回放（002 §7）。
 * 事件类型 → 状态迁移表显式列出；未知事件忽略（视图宽容、总线严格）。
 */
import type { EventId } from './events.ts';

export type TicketStatus = 'open' | 'working' | 'done' | 'failed';

export interface Ticket {
  readonly ticketId: string;
  readonly thread: string;
  readonly mandate: string;
  readonly workerSessionId: string;
  readonly triggerId: EventId;
  status: TicketStatus;
  readonly openedSeq: number;
  endedSeq?: number | undefined;
  readonly replies: Array<{ purpose: 'ack' | 'result' | 'attention'; text: string; seq: number }>;
}

/** 视图增量：每个事件对视图的影响。 */
export interface TicketView {
  readonly byId: Map<string, Ticket>;
  readonly byThread: Map<string, string[]>;
}

export function applyTicketEvent(view: TicketView, ev: { seq: number; type: string; payload: unknown }): void {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'ticket.opened': {
      const t: Ticket = {
        ticketId: p['ticketId'] as string,
        thread: p['thread'] as string,
        mandate: p['mandate'] as string,
        workerSessionId: p['workerSessionId'] as string,
        triggerId: p['triggerId'] as EventId,
        status: 'open',
        openedSeq: ev.seq,
        replies: [],
      };
      view.byId.set(t.ticketId, t);
      const list = view.byThread.get(t.thread) ?? [];
      list.push(t.ticketId);
      view.byThread.set(t.thread, list);
      break;
    }
    case 'router.dispatched': {
      const t = view.byId.get(p['ticketId'] as string);
      if (t !== undefined && t.status === 'open') t.status = 'working';
      break;
    }
    case 'reply.sent': {
      const t = view.byId.get(p['ticketId'] as string);
      if (t !== undefined) {
        t.replies.push({ purpose: p['purpose'] as 'ack' | 'result' | 'attention', text: p['text'] as string, seq: ev.seq });
      }
      break;
    }
    case 'ticket.ended': {
      const t = view.byId.get(p['ticketId'] as string);
      if (t !== undefined) {
        t.status = p['outcome'] === 'failed' ? 'failed' : 'done';
        t.endedSeq = ev.seq;
      }
      break;
    }
    default:
      break; // 视图只关心 Ticket 相关事件
  }
}

export function newTicketView(): TicketView {
  return { byId: new Map(), byThread: new Map() };
}

/** 从事件序列全量重建（005 §4 重放语义）。 */
export function rebuildTickets(events: ReadonlyArray<{ seq: number; type: string; payload: unknown }>): TicketView {
  const view = newTicketView();
  for (const e of events) applyTicketEvent(view, e);
  return view;
}
