// People on a ticket's detail view: comment authors, event actors, the assignee and who assigned
// them — plus the customer-plane redaction of the event log. Pure, so the privacy rules can be
// pinned by unit tests without a database; getTicket (tickets.ts) does the I/O.
import { nameRef, type UserName } from './user-names.js';

interface EventRow { actor_id: string | null; event_type: string; detail: Record<string, unknown> | null; created_at: string | Date }
interface CommentRow { author_id: string | null }

/**
 * Event types a customer may see, and the detail fields of each that are safe to show them.
 * Anything not listed is dropped outright — a new event type stays hidden until someone decides
 * what of it a customer should read, instead of leaking whatever its detail happens to hold.
 *
 * - escalated: kept (the customer can see their ticket moved), but `reason` is the agent's
 *   internal note, `from_agent` the prior owner, and `to` the desk's tier routing.
 * - assigned: kept so "assigned by" has a source; the agent/group ids are desk internals.
 * - commented: kept only for customer-visible comments (filtered below); an internal note's
 *   event would otherwise announce a comment the customer cannot read.
 * - form_edited / synced: dropped. form_edited carries the editor's reason, which is also
 *   written as an internal note; synced is integration plumbing.
 */
const CUSTOMER_EVENT_FIELDS: Record<string, readonly string[]> = {
  created: ['priority', 'channel'],
  status_changed: ['from', 'to', 'via'],
  commented: ['visibility', 'via'],
  assigned: [],
  escalated: [],
  merged: ['into'],
};

export function redactEventsForCustomer<E extends EventRow>(events: readonly E[]): E[] {
  const out: E[] = [];
  for (const e of events) {
    const allowed = CUSTOMER_EVENT_FIELDS[e.event_type];
    if (!allowed) continue;
    const detail = e.detail ?? {};
    if (e.event_type === 'commented' && detail.visibility !== 'customer') continue;
    const kept: Record<string, unknown> = {};
    for (const k of allowed) if (k in detail) kept[k] = detail[k];
    out.push({ ...e, detail: kept });
  }
  return out;
}

/** The most recent routing decision: who last assigned or escalated the ticket, and when. */
export function latestAssignment(events: readonly EventRow[]): { id: string | null; at: string | Date } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type === 'assigned' || e.event_type === 'escalated') return { id: e.actor_id, at: e.created_at };
  }
  return null;
}

/** Every user id the detail view needs a name for. */
export function ticketUserIds(t: {
  assigned_agent_id?: string | null;
  comments: readonly CommentRow[];
  events: readonly Pick<EventRow, 'actor_id'>[];
}): Set<string> {
  const ids = new Set<string>();
  if (t.assigned_agent_id) ids.add(t.assigned_agent_id);
  for (const c of t.comments) if (c.author_id) ids.add(c.author_id);
  for (const e of t.events) if (e.actor_id) ids.add(e.actor_id);
  return ids;
}

/**
 * Attach names: `author` on each comment, `actor` on each event, `assignee`, and `assigned_by`
 * from the latest assigned/escalated event. Names only (never emails), so this is safe on the
 * customer plane — but run redactEventsForCustomer FIRST there, so `assigned_by` and the actors
 * come only from events the customer may see.
 */
export function withTicketNames<
  T extends { assigned_agent_id?: string | null; comments: C[]; events: E[] },
  C extends CommentRow,
  E extends EventRow,
>(t: T, names: ReadonlyMap<string, string | null>) {
  const by = latestAssignment(t.events);
  return {
    ...t,
    comments: t.comments.map((c) => ({ ...c, author: nameRef(names, c.author_id) })),
    events: t.events.map((e) => ({ ...e, actor: nameRef(names, e.actor_id) })),
    assignee: nameRef(names, t.assigned_agent_id),
    assigned_by: by ? { id: by.id, name: by.id ? names.get(by.id) ?? null : null, at: by.at } : null,
  } as Omit<T, 'comments' | 'events'> & {
    comments: Array<C & { author: UserName | null }>;
    events: Array<E & { actor: UserName | null }>;
    assignee: UserName | null;
    assigned_by: { id: string | null; name: string | null; at: string | Date } | null;
  };
}
