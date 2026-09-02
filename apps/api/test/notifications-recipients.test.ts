import { describe, it, expect, vi } from 'vitest';
import { resolveRecipients } from '../src/modules/notifications-recipients.js';
import type { DomainEvent } from '../src/events/bus.js';

// Routes each query to a canned result by matching the SQL text. `ticket` is the
// row returned by ticketParties; `covering` are the org's covering agents;
// `users` maps user-id -> email for usersByIds (so we can assert exactly which
// parties were resolved per event).
function makeSql(opts: {
  ticket?: { requester_id: string | null; assigned_agent_id: string | null; organization_id: string; desk_email?: string | null };
  covering?: Array<{ user_id: string; email: string }>;
  users?: Record<string, string>;
}) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    calls.push({ text, params });
    if (text.includes('FROM tickets')) return { rows: opts.ticket ? [opts.ticket] : [] };
    if (text.includes("u.plane = 'nexus'")) return { rows: opts.covering ?? [] };
    if (text.includes('u.id = ANY')) {
      const ids: string[] = params?.[0] ?? [];
      return { rows: ids.filter((id) => opts.users?.[id]).map((id) => ({ user_id: id, email: opts.users![id] })) };
    }
    return { rows: [] };
  });
  return { sql: { query } as any, calls };
}

function evt(type: string, data: Record<string, unknown>): DomainEvent {
  return { event_id: 'e', type, occurred_at: '', organization_id: 'org-1', idempotency_key: 'k', version: 1, data };
}

const emails = (rs: Array<{ email: string }>) => rs.map((r) => r.email).sort();

describe('resolveRecipients — event-aware routing', () => {
  it('ticket.created (unassigned) notifies the covering team + the shared desk mailbox (never the customer)', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: null, organization_id: 'org-1', desk_email: 'desk@team' },
      covering: [{ user_id: 'ag1', email: 'a1@nexus' }, { user_id: 'ag2', email: 'a2@nexus' }],
      users: { 'cust-1': 'cust@acme' },
    });
    const out = await resolveRecipients(sql, evt('ticket.created', { ticket_id: 't1' }));
    // real agents are reliably alerted, plus the group desk mailbox — but never the requester
    expect(emails(out)).toEqual(['a1@nexus', 'a2@nexus', 'desk@team']);
    expect(emails(out)).not.toContain('cust@acme');
  });

  it('ticket.created (unassigned, no group address) falls back to the platform default desk mailbox', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: null, organization_id: 'org-1', desk_email: null },
    });
    const out = await resolveRecipients(sql, evt('ticket.created', { ticket_id: 't1' }));
    // dev default from config.notifications.serviceDeskEmail
    expect(out).toEqual([{ userId: 'desk:service-desk@nexus.example.com', email: 'service-desk@nexus.example.com' }]);
  });

  it('ticket.acknowledged addresses the inbound sender directly (no user account required)', async () => {
    const { sql, calls } = makeSql({});
    const out = await resolveRecipients(sql, evt('ticket.acknowledged', { ticket_id: 't1', recipient_email: 'caller@acme.gov' }));
    expect(out).toEqual([{ userId: 'requester:caller@acme.gov', email: 'caller@acme.gov' }]);
    expect(calls.some((c) => c.text.includes('FROM tickets'))).toBe(false); // resolved from event data
  });

  it('ticket.acknowledged with no recipient email resolves to nobody', async () => {
    const { sql } = makeSql({});
    const out = await resolveRecipients(sql, evt('ticket.acknowledged', { ticket_id: 't1' }));
    expect(out).toEqual([]);
  });

  it('ticket.acknowledged falls back to the ticket requester (portal/agent tickets)', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.acknowledged', { ticket_id: 't1' }));
    expect(emails(out)).toEqual(['cust@acme']); // requester only, never the agent
  });

  it('csat.survey_created notifies only the ticket requester', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag9', organization_id: 'org-1' },
      users: { 'cust-1': 'cust@acme', ag9: 'ag9@nexus' },
    });
    const out = await resolveRecipients(sql, evt('csat.survey_created', { ticket_id: 't1' }));
    expect(emails(out)).toEqual(['cust@acme']); // requester only, not the agent
  });

  it('csat.survey_created with no requester resolves to nobody', async () => {
    const { sql } = makeSql({ ticket: { requester_id: null, assigned_agent_id: 'ag9', organization_id: 'org-1' } });
    const out = await resolveRecipients(sql, evt('csat.survey_created', { ticket_id: 't1' }));
    expect(out).toEqual([]);
  });

  it('ticket.created (already assigned) notifies just the assignee', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag9', organization_id: 'org-1' },
      users: { ag9: 'ag9@nexus', 'cust-1': 'cust@acme' },
    });
    const out = await resolveRecipients(sql, evt('ticket.created', { ticket_id: 't1' }));
    expect(emails(out)).toEqual(['ag9@nexus']);
  });

  it('ticket.assigned notifies the newly assigned agent AND the requester (now in progress)', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'old', organization_id: 'org-1' },
      users: { agNew: 'new@nexus', 'cust-1': 'cust@acme', old: 'old@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.assigned', { ticket_id: 't1', agent_id: 'agNew' }));
    expect(emails(out)).toEqual(['cust@acme', 'new@nexus']);
  });

  it('ticket.status_changed to a terminal state is suppressed (dedicated resolved/closed handles it)', async () => {
    const { sql } = makeSql({ ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' }, users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' } });
    expect(await resolveRecipients(sql, evt('ticket.status_changed', { ticket_id: 't1', to: 'resolved' }))).toEqual([]);
    expect(await resolveRecipients(sql, evt('ticket.status_changed', { ticket_id: 't1', to: 'closed' }))).toEqual([]);
    // reopen (leaving a terminal state) is also suppressed — ticket.reopened handles it
    expect(await resolveRecipients(sql, evt('ticket.status_changed', { ticket_id: 't1', from: 'resolved', to: 'in_progress' }))).toEqual([]);
  });

  it('ticket.closed and ticket.reopened notify the requester + assignee', async () => {
    const { sql } = makeSql({ ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' }, users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' } });
    expect(emails(await resolveRecipients(sql, evt('ticket.closed', { ticket_id: 't1' })))).toEqual(['a1@nexus', 'cust@acme']);
    expect(emails(await resolveRecipients(sql, evt('ticket.reopened', { ticket_id: 't1' })))).toEqual(['a1@nexus', 'cust@acme']);
  });

  it('approval outcomes notify the request requester (via subject_id)', async () => {
    const { sql } = makeSql({ ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' }, users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' } });
    for (const type of ['approval.requested', 'approval.approved', 'approval.rejected']) {
      expect(emails(await resolveRecipients(sql, evt(type, { subject_id: 't1' })))).toEqual(['cust@acme']);
    }
  });

  it('ticket.status_changed notifies the requester (customer) + assignee', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.status_changed', { ticket_id: 't1', to: 'in_progress' }));
    expect(emails(out)).toEqual(['a1@nexus', 'cust@acme']);
  });

  it('ticket.resolved notifies the requester (customer) + assignee', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.resolved', { ticket_id: 't1' }));
    expect(emails(out)).toEqual(['a1@nexus', 'cust@acme']);
  });

  it('ticket.commented (customer-visible) reaches the requester', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.commented', { ticket_id: 't1', visibility: 'customer' }));
    expect(emails(out)).toEqual(['a1@nexus', 'cust@acme']);
  });

  it('ticket.commented (internal) stays with agents and never reaches the customer', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      covering: [{ user_id: 'ag2', email: 'a2@nexus' }],
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('ticket.commented', { ticket_id: 't1', visibility: 'internal' }));
    expect(emails(out)).toEqual(['a1@nexus', 'a2@nexus']);
    expect(out.some((r) => r.email === 'cust@acme')).toBe(false);
  });

  it('sla.breached is internal: assignee + covering team, not the customer', async () => {
    const { sql } = makeSql({
      ticket: { requester_id: 'cust-1', assigned_agent_id: 'ag1', organization_id: 'org-1' },
      covering: [{ user_id: 'ag2', email: 'a2@nexus' }],
      users: { 'cust-1': 'cust@acme', ag1: 'a1@nexus' },
    });
    const out = await resolveRecipients(sql, evt('sla.breached', { ticket_id: 't1' }));
    expect(emails(out)).toEqual(['a1@nexus', 'a2@nexus']);
    expect(out.some((r) => r.email === 'cust@acme')).toBe(false);
  });

  it('returns empty (no ticket lookup) when no ticket id is present', async () => {
    const { sql, calls } = makeSql({});
    const out = await resolveRecipients(sql, evt('ticket.created', {}));
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---- Unchanged branches (posture admins, on-call responder) ----
function fakeSql(rows: any[]) {
  return { query: vi.fn(async () => ({ rows })) } as any;
}

describe('resolveRecipients — other event families', () => {
  it('resolves org admins for posture events', async () => {
    const sql = fakeSql([{ user_id: 'a1', email: 'admin@x.gov' }]);
    const out = await resolveRecipients(sql, evt('posture.finding_created', {}));
    expect(out).toEqual([{ userId: 'a1', email: 'admin@x.gov' }]);
    expect(sql.query.mock.calls[0][0]).toContain('role_assignments');
    expect(sql.query.mock.calls[0][1]).toEqual(['org-1']);
  });

  it('resolves the specific responder for oncall.acknowledgement_required', async () => {
    const sql = fakeSql([{ user_id: 'resp-1', email: 'oncall@x.gov' }]);
    const out = await resolveRecipients(
      sql,
      evt('oncall.acknowledgement_required', { page_id: 'p1', responder: 'resp-1' }),
    );
    expect(out).toEqual([{ userId: 'resp-1', email: 'oncall@x.gov' }]);
    expect(sql.query.mock.calls[0][1]).toEqual(['resp-1']);
  });
});

// ---- CAB voting lifecycle (spec 2026-06-25, task 7) ----
//
// Every branch is queried with (change_id, organization_id) as $1/$2. `makeChangeSql`
// simulates real Postgres row-scoping: passing an `*Org` value means the fake "table"
// only returns rows when the query's organization_id param matches it, so a test can
// prove that mismatched tenancy yields zero rows without needing a live database.
function makeChangeSql(opts: {
  changeVotes?: Array<{ user_id: string; email: string }>;
  changeVotesOrg?: string;
  chair?: { user_id: string; email: string } | null;
  chairOrg?: string;
  creator?: { user_id: string; email: string } | null;
  creatorOrg?: string;
}) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    calls.push({ text, params });
    const orgParam = params?.[1];
    if (text.includes('FROM change_votes')) {
      if (opts.changeVotesOrg !== undefined && orgParam !== opts.changeVotesOrg) return { rows: [] };
      return { rows: opts.changeVotes ?? [] };
    }
    if (text.includes('cab_boards')) {
      if (opts.chairOrg !== undefined && orgParam !== opts.chairOrg) return { rows: [] };
      return { rows: opts.chair ? [opts.chair] : [] };
    }
    if (text.includes('c.created_by')) {
      if (opts.creatorOrg !== undefined && orgParam !== opts.creatorOrg) return { rows: [] };
      return { rows: opts.creator ? [opts.creator] : [] };
    }
    return { rows: [] };
  });
  return { sql: { query } as any, calls };
}

describe('resolveRecipients — CAB voting lifecycle', () => {
  it('cab_requested resolves board members from change_votes, scoped to the change\'s own organization', async () => {
    const { sql, calls } = makeChangeSql({
      changeVotes: [
        { user_id: 'v1', email: 'chair@acme' },
        { user_id: 'v2', email: 'member@acme' },
      ],
      changeVotesOrg: 'org-1',
    });
    const out = await resolveRecipients(sql, evt('change.cab_requested', { change_id: 'chg-1', voter_ids: ['v1', 'v2'] }));
    expect(emails(out)).toEqual(['chair@acme', 'member@acme']);
    expect(calls[0].params).toEqual(['chg-1', 'org-1']); // tenant-scoped: change_id AND organization_id
  });

  it('cab_requested resolves strictly from change_votes, ignoring the event payload\'s voter_ids', async () => {
    const { sql } = makeChangeSql({ changeVotes: [{ user_id: 'v1', email: 'chair@acme' }], changeVotesOrg: 'org-1' });
    // Payload claims a different (untrusted) voter list than what change_votes actually has.
    const out = await resolveRecipients(sql, evt('change.cab_requested', { change_id: 'chg-1', voter_ids: ['someone-else'] }));
    expect(emails(out)).toEqual(['chair@acme']);
  });

  it('cab_requested never leaks another tenant\'s ballots for the same change_id', async () => {
    // The event claims org-1 (via evt()'s organization_id), but this change_id's rows in
    // the fake "table" belong to a different org — simulating a mis-addressed event.
    // Because the query is scoped by (change_id, organization_id) together, nothing comes back.
    const { sql } = makeChangeSql({ changeVotes: [{ user_id: 'v1', email: 'chair@other-org' }], changeVotesOrg: 'org-OTHER' });
    const out = await resolveRecipients(sql, evt('change.cab_requested', { change_id: 'chg-1' }));
    expect(out).toEqual([]);
  });

  it('cab_requested resolves nobody (and queries nothing) without a change_id', async () => {
    const { sql, calls } = makeChangeSql({});
    const out = await resolveRecipients(sql, evt('change.cab_requested', {}));
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('vote_cast notifies the chair, resolved via the change\'s own board and organization', async () => {
    const { sql, calls } = makeChangeSql({ chair: { user_id: 'chair-1', email: 'chair@acme' }, chairOrg: 'org-1' });
    const out = await resolveRecipients(sql, evt('change.vote_cast', { change_id: 'chg-1', voter_id: 'v2', vote: 'approve' }));
    expect(out).toEqual([{ userId: 'chair-1', email: 'chair@acme' }]);
    expect(calls[0].params).toEqual(['chg-1', 'org-1']);
  });

  it('vote_cast resolves nobody when the board has no chair configured', async () => {
    const { sql } = makeChangeSql({ chair: null });
    const out = await resolveRecipients(sql, evt('change.vote_cast', { change_id: 'chg-1', voter_id: 'v2', vote: 'approve' }));
    expect(out).toEqual([]);
  });

  it('vote_overdue (the deadline sweeper\'s escalation) resolves the chair the same way as vote_cast', async () => {
    const { sql } = makeChangeSql({ chair: { user_id: 'chair-1', email: 'chair@acme' }, chairOrg: 'org-1' });
    const out = await resolveRecipients(sql, evt('change.vote_overdue', { change_id: 'chg-1', vote_deadline: '2026-06-16T00:00:00Z' }));
    expect(out).toEqual([{ userId: 'chair-1', email: 'chair@acme' }]);
  });

  it.each(['change.approved', 'change.rejected', 'change.scheduled'])(
    '%s notifies the change creator, scoped to its own organization',
    async (type) => {
      const { sql, calls } = makeChangeSql({ creator: { user_id: 'raiser-1', email: 'raiser@acme' }, creatorOrg: 'org-1' });
      const out = await resolveRecipients(sql, evt(type, { change_id: 'chg-1' }));
      expect(out).toEqual([{ userId: 'raiser-1', email: 'raiser@acme' }]);
      expect(calls[0].params).toEqual(['chg-1', 'org-1']);
    },
  );
});
