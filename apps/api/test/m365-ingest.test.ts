import { describe, it, expect, vi } from 'vitest';
import { fetchNewMessages, ingestMessage, extractTicketNumber } from '../src/integrations/m365/ingest.js';
import { subscribe } from '../src/events/bus.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSql(handlers: Record<string, any>) {
  const calls: any[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    calls.push({ text, params });
    for (const key of Object.keys(handlers)) {
      if (text.includes(key)) return handlers[key];
    }
    return { rows: [] };
  });
  return { sql: { query } as any, calls };
}

const msg = {
  id: 'm1',
  internetMessageId: '<abc@x>',
  fromAddress: 'sender@acme.gov',
  fromName: '',
  subject: 'Help please',
  bodyPreview: 'My laptop is broken',
};

describe('ingest', () => {
  it('creates a ticket when the sender domain maps to an org', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] }, // not seen before
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'SELECT COALESCE(MAX': { rows: [{ n: 5 }] },
      'SELECT name FROM organizations': { rows: [{ name: 'Acme' }] },
      'INSERT INTO tickets': { rows: [{ id: 't-new', created_at: '2026-06-13T14:30:00.000Z', priority: 'P3' }] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(true);
  });

  it('skips and reports when the domain is unmatched', async () => {
    const { sql } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('unmatched-domain');
  });

  it('skips a message already processed (dedupe)', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [{ value: true }] }, // seen
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('duplicate');
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(false);
  });

  it('fetchNewMessages primes the delta cursor on first run without ingesting the existing inbox', async () => {
    const graphClient = {
      get: vi.fn(async () => ({
        value: [
          { id: 'm1', internetMessageId: '<a@x>', subject: 'S', bodyPreview: 'b',
            from: { emailAddress: { address: 'p@acme.gov' } } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.us/v1.0/delta?token=NEXT',
      })),
      post: vi.fn(),
    } as any;
    // No stored cursor -> prime only; the pre-existing inbox is NOT ticketed.
    const { sql, calls } = makeSql({ 'FROM integration_state': { rows: [] } });
    const out = await fetchNewMessages(sql, graphClient, 'svc@agency.gov');
    expect(out).toHaveLength(0); // backlog skipped
    expect(calls.some((c) => c.text.includes('INSERT INTO integration_state'))).toBe(true); // cursor stored
  });

  it('fetchNewMessages returns new messages once the delta cursor is established', async () => {
    const graphClient = {
      get: vi.fn(async () => ({
        value: [
          { id: 'm2', internetMessageId: '<b@x>', subject: 'S2', bodyPreview: 'b2',
            from: { emailAddress: { address: 'q@acme.gov' } } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.us/v1.0/delta?token=NEXT2',
      })),
      post: vi.fn(),
    } as any;
    // A stored cursor exists -> normal incremental ingest of new mail.
    const { sql } = makeSql({
      'FROM integration_state': { rows: [{ value: { deltaLink: 'https://graph.microsoft.us/v1.0/delta?token=PREV' } }] },
    });
    const out = await fetchNewMessages(sql, graphClient, 'svc@agency.gov');
    expect(out).toHaveLength(1);
    expect(out[0].fromAddress).toBe('q@acme.gov');
  });

  it('publishes ticket.created (desk) and ticket.acknowledged (customer no-reply) after creating a ticket', async () => {
    const got: Record<string, any> = {};
    subscribe('ticket.created', (e) => { got['ticket.created'] = e; });
    subscribe('ticket.acknowledged', (e) => { got['ticket.acknowledged'] = e; });

    const { sql } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'SELECT COALESCE(MAX': { rows: [{ n: 5 }] },
      'SELECT name FROM organizations': { rows: [{ name: 'Acme' }] },
      'FROM users WHERE organization_id': { rows: [{ id: 'user-sender', display_name: 'Sam Sender' }] }, // sender has an account
      'INSERT INTO tickets': { rows: [{ id: 't-new', created_at: '2026-06-13T14:30:00.000Z', priority: 'P3' }] },
    });

    // Unique internetMessageId so the bus idempotency keys don't collide with the
    // other tests in this file (which reuse `msg`).
    const out = await ingestMessage(sql, { ...msg, fromName: 'Sam Sender', internetMessageId: '<publish-test@x>' });
    expect(out.created).toBe(true);
    await flush(); // let async bus handlers run

    // Desk notification — same pipeline as portal/agent tickets, with email channel + linked requester.
    expect(got['ticket.created']).toBeTruthy();
    expect(got['ticket.created'].data.ticket_id).toBe('t-new');
    expect(got['ticket.created'].data.channel).toBe('email');
    expect(got['ticket.created'].data.requester_id).toBe('user-sender');
    expect(got['ticket.created'].data.ticket_number).toBe('ACME-000005');

    // Customer auto-acknowledgment addressed to the inbound sender (works even with no user account),
    // carrying the details the template renders (name, ticket id, summary, submitted time, priority).
    expect(got['ticket.acknowledged']).toBeTruthy();
    expect(got['ticket.acknowledged'].data.recipient_email).toBe('sender@acme.gov');
    expect(got['ticket.acknowledged'].data.ticket_number).toBe('ACME-000005');
    expect(got['ticket.acknowledged'].data.subject).toBe('Help please');
    expect(got['ticket.acknowledged'].data.customer_name).toBe('Sam Sender'); // linked user's display name
    expect(got['ticket.acknowledged'].data.submitted_at).toBe('2026-06-13T14:30:00.000Z');
    expect(got['ticket.acknowledged'].data.priority).toBeTruthy();
  });

  it('threads a reply onto the existing ticket (no new ticket) and reopens it', async () => {
    const got: Record<string, any> = {};
    subscribe('ticket.commented', (e) => { got['ticket.commented'] = e; });
    subscribe('ticket.reopened', (e) => { got['ticket.reopened'] = e; });
    subscribe('ticket.created', (e) => { got['unexpected.created'] = e; });

    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'ticket_number=$2': { rows: [{ id: 't-existing', status: 'resolved', assigned_agent_id: 'ag1' }] },
      'FROM users WHERE organization_id': { rows: [{ id: 'user-sender' }] },
    });

    const out = await ingestMessage(sql, {
      ...msg,
      internetMessageId: '<reply-1@x>',
      subject: 'RE: [ACME-000005] Help please',
    });
    await flush();

    expect(out.created).toBe(false);
    expect(out.reason).toBe('threaded');
    expect(out.ticketId).toBe('t-existing');
    // appended a comment, did NOT open a new ticket
    expect(calls.some((c) => c.text.includes('INSERT INTO ticket_comments'))).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(false);
    // resolved -> reopened. This asserted 'in_progress' until the reopen was fixed: that is
    // not a legal target from 'resolved', and it left the ticket looking un-resolved with no
    // timeline entry explaining why. The assignee no longer changes where it lands.
    expect(got['ticket.reopened']?.data.to).toBe('reopened');
    expect(got['ticket.commented']?.data.ticket_id).toBe('t-existing');
    expect(got['unexpected.created']).toBeUndefined();
  });

  it('creates a new ticket when the subject ticket number does not match an existing ticket', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'ticket_number=$2': { rows: [] }, // no such ticket -> fall through to create
      'SELECT COALESCE(MAX': { rows: [{ n: 9 }] },
      'SELECT name FROM organizations': { rows: [{ name: 'Acme' }] },
      'FROM users WHERE organization_id': { rows: [] },
      'INSERT INTO tickets': { rows: [{ id: 't-fresh', created_at: '2026-06-13T00:00:00.000Z', priority: 'P3' }] },
    });
    const out = await ingestMessage(sql, { ...msg, internetMessageId: '<reply-2@x>', subject: 'RE: [ZZZZ-999999] stale ref' });
    expect(out.created).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(true);
  });
});

describe('extractTicketNumber', () => {
  it('pulls the number from a quoted reply subject', () => {
    expect(extractTicketNumber('RE: [ACME-000005] Help please')).toBe('ACME-000005');
    expect(extractTicketNumber('Fwd: QUAN-000123 — update')).toBe('QUAN-000123');
  });
  it('returns null when there is no ticket number', () => {
    expect(extractTicketNumber('New problem with VPN')).toBeNull();
    expect(extractTicketNumber('')).toBeNull();
  });
});

// A customer reply on a resolved ticket reopens it — that part is intended. HOW it reopened
// was not: ingest wrote `status` straight to 'in_progress' (or 'triage'), which is not a legal
// target from 'resolved' in any workflow map, left `resolved_at` stamped from the earlier
// resolve, and recorded no `status_changed` event. To the desk that reads as "I resolved this
// and it didn't stick": the ticket is back in an active state, the timeline says nothing about
// why, and the row still carries a resolve timestamp. Seen in prod on STR-000001/STR-000002,
// the latter resolved three times in a row.
describe('ingest — reopening a resolved ticket', () => {
  const replyMsg = {
    id: 'm9',
    internetMessageId: '<reply@x>',
    fromAddress: 'sender@acme.gov',
    fromName: '',
    subject: 'RE: [ACME-000012] still broken',
    bodyPreview: 'it is happening again',
  };

  function resolvedTicketSql() {
    return makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'SELECT id, status, assigned_agent_id FROM tickets': {
        rows: [{ id: 't-1', status: 'resolved', assigned_agent_id: 'agent-1' }],
      },
      'FROM users WHERE organization_id': { rows: [{ id: 'u-1' }] },
    });
  }

  it('moves it to a status that is legal from resolved, not straight back into in_progress', async () => {
    const { sql, calls } = resolvedTicketSql();
    await ingestMessage(sql, replyMsg);
    const upd = calls.find((c: any) => c.text.includes('UPDATE tickets SET status'));
    expect(upd).toBeTruthy();
    // DEFAULT_TRANSITIONS (workflows.ts) allows resolved -> closed | reopened. Nothing else.
    expect(upd.params[0]).toBe('reopened');
  });

  it('clears the resolve stamp, so the row does not read as resolved-and-open at once', async () => {
    const { sql, calls } = resolvedTicketSql();
    await ingestMessage(sql, replyMsg);
    const upd = calls.find((c: any) => c.text.includes('UPDATE tickets SET status'));
    expect(upd.text.replace(/\s+/g, ' ')).toContain('resolved_at = NULL');
  });

  it('records a status_changed event, so the timeline explains the flip', async () => {
    const { sql, calls } = resolvedTicketSql();
    await ingestMessage(sql, replyMsg);
    const statusEvents = calls.filter(
      (c: any) => c.text.includes('INSERT INTO ticket_events') && c.text.includes("'status_changed'"),
    );
    expect(statusEvents.length).toBe(1);
  });
});

// The closed case carries the same stale-stamp hazard as the resolved one.
it('clears closed_at when a reply reopens a closed ticket', async () => {
  const { sql, calls } = makeSql({
    'FROM integration_state': { rows: [] },
    'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
    'SELECT id, status, assigned_agent_id FROM tickets': {
      rows: [{ id: 't-2', status: 'closed', assigned_agent_id: null }],
    },
    'FROM users WHERE organization_id': { rows: [{ id: 'u-1' }] },
  });
  await ingestMessage(sql, {
    id: 'm10', internetMessageId: '<reply2@x>', fromAddress: 'sender@acme.gov',
    fromName: '', subject: 'RE: [ACME-000013] one more thing', bodyPreview: 'hello',
  });
  const upd = calls.find((c: any) => c.text.includes('UPDATE tickets SET status'));
  expect(upd.params[0]).toBe('reopened');
  expect(upd.text.replace(/\s+/g, ' ')).toContain('closed_at = NULL');
});
