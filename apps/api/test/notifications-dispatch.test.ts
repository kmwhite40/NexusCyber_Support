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
    // recipient resolution
    return { rows: opts.recipients };
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
});
