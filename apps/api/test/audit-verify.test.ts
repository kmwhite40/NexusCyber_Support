import { describe, it, expect } from 'vitest';
import { verifyChain, type AuditRow } from '../src/modules/audit.js';
import { createHash } from 'node:crypto';

// Rebuild the same payload+hash the writer uses, so we can construct valid chains.
function link(prev: string | null, row: Omit<AuditRow, 'prev_hash' | 'row_hash'>): AuditRow {
  const payload = JSON.stringify({
    actor: row.actor_id ?? null,
    action: row.action,
    resource: row.resource_id ?? null,
    detail: row.detail ?? {},
    at: row.created_at,
  });
  const row_hash = createHash('sha256').update((prev ?? '') + payload).digest('hex');
  return { ...row, prev_hash: prev, row_hash };
}

const r1 = link(null, { actor_id: 'a', action: 'x', resource_id: null, detail: {}, created_at: '2026-01-01T00:00:00.000Z' });
const r2 = link(r1.row_hash, { actor_id: 'a', action: 'y', resource_id: null, detail: {}, created_at: '2026-01-02T00:00:00.000Z' });

describe('verifyChain', () => {
  it('reports intact for a valid chain', () => {
    expect(verifyChain([r1, r2])).toEqual({ ok: true, checked: 2, brokenAt: null });
  });

  it('reports intact for an empty log', () => {
    expect(verifyChain([])).toEqual({ ok: true, checked: 0, brokenAt: null });
  });

  it('detects a tampered row', () => {
    const tampered = { ...r2, action: 'TAMPERED' };
    const res = verifyChain([r1, tampered]);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });
});
