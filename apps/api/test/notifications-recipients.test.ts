import { describe, it, expect, vi } from 'vitest';
import { resolveRecipients } from '../src/modules/notifications-recipients.js';
import type { DomainEvent } from '../src/events/bus.js';

function fakeSql(rows: any[]) {
  return { query: vi.fn(async () => ({ rows })) } as any;
}
function evt(type: string, data: Record<string, unknown>): DomainEvent {
  return {
    event_id: 'e', type, occurred_at: '', organization_id: 'org-1',
    idempotency_key: 'k', version: 1, data,
  };
}

describe('resolveRecipients', () => {
  it('resolves ticket assignee + requester for sla events and queries tickets', async () => {
    const sql = fakeSql([
      { user_id: 'u1', email: 'agent@x.gov' },
      { user_id: 'u2', email: 'req@y.gov' },
    ]);
    const out = await resolveRecipients(sql, evt('sla.breached', { ticket_id: 't1' }));
    expect(out.map((r) => r.email).sort()).toEqual(['agent@x.gov', 'req@y.gov']);
    expect(sql.query.mock.calls[0][0]).toContain('FROM tickets');
    expect(sql.query.mock.calls[0][1]).toEqual(['t1']);
  });

  it('resolves org admins for posture events', async () => {
    const sql = fakeSql([{ user_id: 'a1', email: 'admin@x.gov' }]);
    const out = await resolveRecipients(sql, evt('posture.finding_created', {}));
    expect(out).toEqual([{ userId: 'a1', email: 'admin@x.gov' }]);
    expect(sql.query.mock.calls[0][0]).toContain('role_assignments');
    expect(sql.query.mock.calls[0][1]).toEqual(['org-1']);
  });

  it('returns empty (no query) for ticket events without a ticket id', async () => {
    const sql = fakeSql([]);
    const out = await resolveRecipients(sql, evt('ticket.created', {}));
    expect(out).toEqual([]);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('dedupes by user id', async () => {
    const sql = fakeSql([
      { user_id: 'u1', email: 'a@x.gov' },
      { user_id: 'u1', email: 'a@x.gov' },
    ]);
    const out = await resolveRecipients(sql, evt('sla.warning', { ticket_id: 't1' }));
    expect(out).toEqual([{ userId: 'u1', email: 'a@x.gov' }]);
  });
});
