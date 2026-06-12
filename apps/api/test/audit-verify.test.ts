import { describe, it, expect } from 'vitest';
import { verifyChain, stableStringify, type AuditRow } from '../src/modules/audit.js';
import { createHash } from 'node:crypto';

// Rebuild the same payload+hash the writer uses (canonical, key-sorted), so we can
// construct valid chains.
function link(prev: string | null, row: Omit<AuditRow, 'prev_hash' | 'row_hash'>): AuditRow {
  const payload = stableStringify({
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

  it('is robust to JSONB key reordering in detail (canonical hashing)', () => {
    // Same row written with detail keys in one order, read back (from JSONB) in another:
    // the canonical hash must still verify.
    const written = link(null, { actor_id: 'a', action: 'x', resource_id: null, detail: { b: 2, a: 1 } as any, created_at: '2026-01-01T00:00:00.000Z' });
    const readBack = { ...written, detail: { a: 1, b: 2 } as any }; // JSONB reordered keys
    expect(verifyChain([readBack]).ok).toBe(true);
  });
});

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
  it('sorts keys recursively', () => {
    expect(stableStringify({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });
});
