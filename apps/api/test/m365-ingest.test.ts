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
      'left(upper(name)': { rows: [{ p: 'ACME' }] },
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
      'left(upper(name)': { rows: [{ p: 'ACME' }] },
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
    // resolved -> reopened (had an assignee -> in_progress), and the desk is notified
    expect(got['ticket.reopened']?.data.to).toBe('in_progress');
    expect(got['ticket.commented']?.data.ticket_id).toBe('t-existing');
    expect(got['unexpected.created']).toBeUndefined();
  });

  it('creates a new ticket when the subject ticket number does not match an existing ticket', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'ticket_number=$2': { rows: [] }, // no such ticket -> fall through to create
      'SELECT COALESCE(MAX': { rows: [{ n: 9 }] },
      'left(upper(name)': { rows: [{ p: 'ACME' }] },
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
