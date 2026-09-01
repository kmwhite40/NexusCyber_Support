import { describe, it, expect } from 'vitest';
import { sensitivePurgeSql, piiPurgeTombstones, writeTombstones } from '../src/jobs/retention-purge.js';

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

// ---------------------------------------------------------------------------
// R14 — one failed tombstone must not cost the rest of the sweep
// ---------------------------------------------------------------------------
describe('writeTombstones', () => {
  const sweep = [
    { organizationId: 'org-1', ticketId: 't-1', values: 2 },
    { organizationId: 'org-1', ticketId: 't-2', values: 1 },
    { organizationId: 'org-2', ticketId: 't-3', values: 5 },
  ];

  it('writes one org-scoped audit record per purged ticket', async () => {
    const calls: any[] = [];
    const res = await writeTombstones(sweep, (async (_actor: any, input: any) => { calls.push(input); }) as any);
    expect(res).toEqual({ written: 3, failed: 0 });
    expect(calls.map((c) => c.resourceId)).toEqual(['t-1', 't-2', 't-3']);
    expect(calls[0]).toMatchObject({
      action: 'pii.purged', organizationId: 'org-1', resourceType: 'ticket',
      detail: { values_destroyed: 2, reason: 'ticket reached a terminal status' },
    });
  });

  // THE DEFECT. The loop ran post-commit with no per-record guard, so a throw on record k
  // abandoned k+1..n — whose PII was already destroyed just as permanently, and for which the
  // audit log was then the only possible evidence, now absent.
  it('bounds one audit failure to one record instead of losing the rest of the sweep', async () => {
    const written: string[] = [];
    const res = await writeTombstones(sweep, (async (_actor: any, input: any) => {
      if (input.resourceId === 't-1') throw new Error('audit chain lock timeout');
      written.push(input.resourceId);
    }) as any);
    expect(written).toEqual(['t-2', 't-3']);
    expect(res).toEqual({ written: 2, failed: 1 });
  });

  it('does not throw even when every tombstone fails', async () => {
    const res = await writeTombstones(sweep, (async () => { throw new Error('audit down'); }) as any);
    expect(res).toEqual({ written: 0, failed: 3 });
  });

  it('writes nothing when nothing was purged', async () => {
    let calls = 0;
    await writeTombstones([], (async () => { calls += 1; }) as any);
    expect(calls).toBe(0);
  });
});
