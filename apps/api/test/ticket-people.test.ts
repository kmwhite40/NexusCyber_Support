// Who wrote it, who did it, who owns it — and what a customer is allowed to see of that.
//
// getTicket used to return raw comment/event rows with no names, so the desk read "Agent
// (internal)" / "Participant" instead of a person, and nobody could see who assigned a ticket.
// Worse, it returned EVERY ticket_event to the customer plane, including an escalation's
// internal reason and the 'commented' events for internal notes the customer cannot read.
import { describe, it, expect } from 'vitest';
import {
  redactEventsForCustomer,
  latestAssignment,
  ticketUserIds,
  withTicketNames,
} from '../src/modules/ticket-people.js';

const AGENT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const AGENT_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const CUSTOMER = 'cccccccc-0000-0000-0000-000000000001';

function ev(event_type: string, detail: Record<string, unknown> | null, actor_id: string | null = AGENT_A, at = '2026-10-01T10:00:00.000Z') {
  return { id: `${event_type}-${at}`, ticket_id: 't1', actor_id, event_type, detail, created_at: at };
}

describe('redactEventsForCustomer', () => {
  it('drops the commented event for an internal note', () => {
    const out = redactEventsForCustomer([
      ev('commented', { visibility: 'internal' }),
      ev('commented', { visibility: 'customer' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detail).toEqual({ visibility: 'customer' });
  });

  it('keeps an escalation but strips its internal reason, prior owner and tier routing', () => {
    const [out] = redactEventsForCustomer([
      ev('escalated', { to: 'Tier 3', reason: 'customer is difficult', reassigned: true, from_agent: AGENT_B }),
    ]);
    expect(out.event_type).toBe('escalated');
    expect(out.detail).toEqual({});
    expect(JSON.stringify(out)).not.toContain('difficult');
    expect(JSON.stringify(out)).not.toContain(AGENT_B);
  });

  it('strips assignment ids but keeps the event, so "assigned by" still has a source', () => {
    const [out] = redactEventsForCustomer([ev('assigned', { assignedAgentId: AGENT_B, assignmentGroupId: 'g1' })]);
    expect(out.detail).toEqual({});
    expect(out.actor_id).toBe(AGENT_A);
  });

  it('keeps the customer-meaningful fields of status changes and creation', () => {
    const out = redactEventsForCustomer([
      ev('created', { priority: 'P2', channel: 'portal', catalog: 'laptop', owning_tier: 'Tier 1' }),
      ev('status_changed', { from: 'resolved', to: 'reopened', via: 'email' }),
    ]);
    expect(out.map((e) => e.detail)).toEqual([
      { priority: 'P2', channel: 'portal' },
      { from: 'resolved', to: 'reopened', via: 'email' },
    ]);
  });

  it('drops event types it does not know, rather than leaking whatever their detail holds', () => {
    // form_edited carries the editor's reason (also written as an internal note); synced is
    // integration plumbing. A future event type defaults to hidden, not shown.
    const out = redactEventsForCustomer([
      ev('form_edited', { fields: ['x'], reason: 'fixing a typo for the CFO' }),
      ev('synced', { external_ref: 'abc', source: 'anchor' }),
      ev('some_future_event', { secret: 1 }),
    ]);
    expect(out).toEqual([]);
  });

  it('survives a null detail', () => {
    expect(redactEventsForCustomer([ev('assigned', null)])[0].detail).toEqual({});
  });

  it('does not mutate the rows it was given', () => {
    const rows = [ev('escalated', { reason: 'r' })];
    redactEventsForCustomer(rows);
    expect(rows[0].detail).toEqual({ reason: 'r' });
  });
});

describe('latestAssignment', () => {
  it('takes the most recent assigned or escalated event', () => {
    const out = latestAssignment([
      ev('assigned', {}, AGENT_A, '2026-10-01T10:00:00.000Z'),
      ev('assigned', {}, AGENT_B, '2026-10-01T11:00:00.000Z'),
      ev('status_changed', {}, AGENT_A, '2026-10-01T12:00:00.000Z'),
    ]);
    expect(out).toEqual({ id: AGENT_B, at: '2026-10-01T11:00:00.000Z' });
  });

  it('counts an escalation as the latest routing decision', () => {
    const out = latestAssignment([
      ev('assigned', {}, AGENT_A, '2026-10-01T10:00:00.000Z'),
      ev('escalated', {}, AGENT_B, '2026-10-01T11:00:00.000Z'),
    ]);
    expect(out?.id).toBe(AGENT_B);
  });

  it('is null when nothing was ever assigned', () => {
    expect(latestAssignment([ev('created', {})])).toBeNull();
  });
});

describe('ticketUserIds', () => {
  it('collects every author, actor and the assignee, once each, skipping nulls', () => {
    const ids = ticketUserIds({
      assigned_agent_id: AGENT_B,
      comments: [{ author_id: CUSTOMER }, { author_id: null }, { author_id: AGENT_A }],
      events: [{ actor_id: AGENT_A }, { actor_id: null }],
    });
    expect([...ids].sort()).toEqual([AGENT_A, AGENT_B, CUSTOMER].sort());
  });
});

describe('withTicketNames', () => {
  const names = new Map<string, string | null>([
    [AGENT_A, 'Avery Agent'],
    [AGENT_B, 'Blake Agent'],
    [CUSTOMER, 'Alex User'],
  ]);

  it('names comment authors, leaving system comments with a null author', () => {
    const t = withTicketNames(
      {
        assigned_agent_id: null,
        comments: [{ id: 'c1', author_id: AGENT_A }, { id: 'c2', author_id: null }],
        events: [],
      },
      names,
    );
    expect(t.comments[0].author).toEqual({ id: AGENT_A, name: 'Avery Agent' });
    expect(t.comments[1].author).toBeNull();
  });

  it('names event actors', () => {
    const t = withTicketNames({ assigned_agent_id: null, comments: [], events: [ev('created', {}, CUSTOMER)] }, names);
    expect(t.events[0].actor).toEqual({ id: CUSTOMER, name: 'Alex User' });
  });

  it('gives the assignee and who assigned them, from the latest assignment', () => {
    const t = withTicketNames(
      {
        assigned_agent_id: AGENT_B,
        comments: [],
        events: [ev('assigned', {}, AGENT_A, '2026-10-01T10:00:00.000Z')],
      },
      names,
    );
    expect(t.assignee).toEqual({ id: AGENT_B, name: 'Blake Agent' });
    expect(t.assigned_by).toEqual({ id: AGENT_A, name: 'Avery Agent', at: '2026-10-01T10:00:00.000Z' });
  });

  it('keeps an id it could not name, with a null name, instead of dropping the person', () => {
    const t = withTicketNames({ assigned_agent_id: 'unknown-id', comments: [], events: [] }, names);
    expect(t.assignee).toEqual({ id: 'unknown-id', name: null });
    expect(t.assigned_by).toBeNull();
  });

  it('never carries an email into the named shapes', () => {
    const t = withTicketNames(
      { assigned_agent_id: AGENT_B, comments: [{ author_id: AGENT_A }], events: [ev('assigned', {}, AGENT_A)] },
      names,
    );
    expect(Object.keys(t.comments[0].author!)).toEqual(['id', 'name']);
    expect(Object.keys(t.assignee!)).toEqual(['id', 'name']);
  });
});
