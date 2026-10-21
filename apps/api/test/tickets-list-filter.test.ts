// The /tickets list WHERE-builder. Tickets and My requests hide Closed by default (closed
// tickets live in Archived), which they ask for with exclude_status; every other caller —
// dashboard, incidents, portal widgets, Archived's status=closed — must see what it saw before.
import { describe, it, expect } from 'vitest';
import { buildTicketListWhere } from '../src/modules/tickets.js';

const ctx = { actorId: 'u-1', ownOnly: false };

describe('buildTicketListWhere', () => {
  it('builds nothing for an empty filter', () => {
    expect(buildTicketListWhere({}, ctx)).toEqual({ clauses: [], params: [] });
  });

  it('scopes a read.own customer to their own tickets', () => {
    expect(buildTicketListWhere({}, { actorId: 'u-1', ownOnly: true })).toEqual({
      clauses: ['requester_id = $1'],
      params: ['u-1'],
    });
  });

  it('keeps the existing single-value filters', () => {
    const r = buildTicketListWhere({ status: 'triage', type: 'incident', priority: 'P1', assignee: 'me' }, ctx);
    expect(r.clauses).toEqual(['status = $1', 'type = $2', 'priority = $3', 'assigned_agent_id = $4']);
    expect(r.params).toEqual(['triage', 'incident', 'P1', 'u-1']);
  });

  it('returns closed for an explicit status=closed (Archived)', () => {
    const r = buildTicketListWhere({ status: 'closed' }, ctx);
    expect(r.clauses).toEqual(['status = $1']);
    expect(r.params).toEqual(['closed']);
  });

  it('excludes a status', () => {
    const r = buildTicketListWhere({ excludeStatus: 'closed' }, ctx);
    expect(r.clauses).toEqual(['status <> ALL($1)']);
    expect(r.params).toEqual([['closed']]);
  });

  it('excludes a comma-separated list of statuses', () => {
    const r = buildTicketListWhere({ excludeStatus: 'resolved, closed' }, { actorId: 'u-1', ownOnly: true });
    expect(r.clauses).toEqual(['requester_id = $1', 'status <> ALL($2)']);
    expect(r.params).toEqual(['u-1', ['resolved', 'closed']]);
  });

  it('lets an explicit status win over an exclusion', () => {
    const r = buildTicketListWhere({ status: 'closed', excludeStatus: 'closed' }, ctx);
    expect(r.clauses).toEqual(['status = $1']);
    expect(r.params).toEqual(['closed']);
  });

  it('ignores an empty exclusion', () => {
    expect(buildTicketListWhere({ excludeStatus: ' , ' }, ctx)).toEqual({ clauses: [], params: [] });
  });
});
