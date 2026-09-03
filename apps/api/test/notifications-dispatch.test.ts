import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../src/modules/notifications.js';
import type { NotificationAdapter } from '../src/integrations/m365/adapter.js';
import type { DomainEvent } from '../src/events/bus.js';

// A fake Sql that answers each query by matching text.
function makeSql(opts: { cloud: string; emailCap: string; teamsCap: string; recipients: any[] }) {
  const inserts: any[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    if (text.includes('FROM organizations')) return { rows: [{ cloud: opts.cloud }] };
    if (text.includes('capability_matrix')) {
      return { rows: [{ capability_matrix: { email: opts.emailCap, teams: opts.teamsCap } }] };
    }
    if (text.startsWith('INSERT INTO notification_deliveries')) {
      inserts.push(params);
      return { rows: [] };
    }
    // recipient resolution (event-aware): ticket parties + covering agents.
    if (text.includes('FROM tickets')) {
      return { rows: [{ requester_id: 'r1', assigned_agent_id: 'ag1', organization_id: 'org-1' }] };
    }
    if (text.includes("u.plane = 'nexus'")) return { rows: opts.recipients }; // covering agents
    return { rows: [] }; // usersByIds (assignee) — covered by covering-agents above
  });
  return { sql: { query } as any, inserts };
}

function evt(type: string): DomainEvent {
  return {
    event_id: 'e', type, occurred_at: '', organization_id: 'org-1',
    idempotency_key: 'k', version: 1, data: { ticket_id: 't1' },
  };
}

function adapterStub(over: Partial<NotificationAdapter> = {}): NotificationAdapter {
  return {
    name: 'stub',
    capabilities: () => ({ email: true, teams: true }),
    sendEmail: vi.fn(async () => ({ status: 'sent', providerMessageId: 'p1' })),
    sendTeams: vi.fn(async () => ({ status: 'sent', providerMessageId: 'p2' })),
    ...over,
  };
}

describe('dispatch', () => {
  it('sends email per recipient and records the portal floor', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'gcc', emailCap: 'supported', teamsCap: 'requires_validation',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }, { user_id: 'u2', email: 'b@x.gov' }],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendEmail).toHaveBeenCalledTimes(2);
    const channels = inserts.map((p) => p[2]); // channel column
    expect(channels).toContain('portal');
    expect(channels.filter((c) => c === 'email').length).toBe(2);
  });

  it('substitutes to portal when no external channel is supported', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'gcchigh', emailCap: 'requires_validation', teamsCap: 'requires_validation',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendEmail).not.toHaveBeenCalled();
    const portal = inserts.find((p) => p[2] === 'portal');
    expect(portal[4]).toBe('sent'); // status column
    expect(inserts.some((p) => p[5] && String(p[5]).includes('falling back'))).toBe(true);
  });

  it('posts to Teams exactly once regardless of recipient count', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'commercial', emailCap: 'requires_validation', teamsCap: 'supported',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }, { user_id: 'u2', email: 'b@x.gov' }, { user_id: 'u3', email: 'c@x.gov' }],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendTeams).toHaveBeenCalledTimes(1);
    expect(adapter.sendEmail).not.toHaveBeenCalled();
    const teamsRows = inserts.filter((p) => p[2] === 'teams');
    expect(teamsRows).toHaveLength(1);
    expect(teamsRows[0][3]).toBeNull(); // recipient column is null for channel posts
  });

  it('records a skipped row for every eligible channel when there are no recipients', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'commercial', emailCap: 'supported', teamsCap: 'supported', recipients: [],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    const skipped = inserts.filter((p) => p[4] === 'skipped');
    expect(skipped.length).toBe(2); // teams + email both skipped, chain not short-circuited
  });

  it('retries a transient email failure, then records sent with the attempt count', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'gcchigh', emailCap: 'supported', teamsCap: 'requires_validation',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }],
    });
    let n = 0;
    const adapter = adapterStub({
      capabilities: () => ({ email: true, teams: false }),
      sendEmail: vi.fn(async () => (++n < 2 ? { status: 'failed', error: '429 throttled' } : { status: 'sent', providerMessageId: 'ok' })),
    });
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendEmail).toHaveBeenCalledTimes(2); // 1 transient failure + 1 success
    const email = inserts.find((p) => p[2] === 'email' && p[4] === 'sent');
    expect(email).toBeTruthy();
    expect(email[7]).toBe(2); // attempts column reflects the retry
  });
});
