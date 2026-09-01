import { describe, it, expect } from 'vitest';
import { sensitivePurgeSql, piiPurgeTombstones } from '../src/jobs/retention-purge.js';

describe('sensitivePurgeSql', () => {
  it('targets only closed or resolved tickets', () => {
    const sql = sensitivePurgeSql();
    expect(sql).toContain('ticket_sensitive_fields');
    expect(sql).toMatch(/status IN \('resolved','closed'\)/);
  });

  // The tombstone needs the org (to scope the audit row) and the ticket (to identify what
  // was destroyed) — and nothing else. Returning `value` would put the PII being destroyed
  // into the job's memory and, from there, one careless log line away from the audit detail.
  it('returns the org and ticket for the tombstone, and never the PII itself', () => {
    const sql = sensitivePurgeSql();
    expect(sql).toMatch(/RETURNING organization_id, ticket_id/);
    expect(sql).not.toMatch(/RETURNING[\s\S]*\bvalue\b/);
    expect(sql).not.toMatch(/\bkey\b/);
  });
});

describe('piiPurgeTombstones', () => {
  it('emits one org-scoped record per ticket, counting the values destroyed', () => {
    const out = piiPurgeTombstones([
      { organization_id: 'org-1', ticket_id: 't-1' },
      { organization_id: 'org-1', ticket_id: 't-1' },
      { organization_id: 'org-1', ticket_id: 't-1' },
      { organization_id: 'org-2', ticket_id: 't-9' },
    ]);
    expect(out).toEqual([
      { organizationId: 'org-1', ticketId: 't-1', values: 3 },
      { organizationId: 'org-2', ticketId: 't-9', values: 1 },
    ]);
  });

  it('emits nothing when nothing was purged (no empty audit rows)', () => {
    expect(piiPurgeTombstones([])).toEqual([]);
  });

  it('carries no PII — only ids and a count', () => {
    const out = piiPurgeTombstones([{ organization_id: 'org-1', ticket_id: 't-1' }]);
    expect(Object.keys(out[0]).sort()).toEqual(['organizationId', 'ticketId', 'values']);
  });
});
