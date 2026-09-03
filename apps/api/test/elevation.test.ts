import { describe, it, expect } from 'vitest';
import { isGrantActive, mergeGrantedPermissions, type GrantRow } from '../src/modules/elevation.js';

const now = new Date('2026-06-11T12:00:00.000Z');

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'g1',
    user_id: 'u1',
    granted_permissions: ['ticket.assign'],
    status: 'active',
    break_glass: false,
    expires_at: '2026-06-11T13:00:00.000Z',
    ...overrides,
  };
}

describe('isGrantActive', () => {
  it('is true for an active, unexpired grant', () => {
    expect(isGrantActive(grant(), now)).toBe(true);
  });
  it('is false once expired', () => {
    expect(isGrantActive(grant({ expires_at: '2026-06-11T11:00:00.000Z' }), now)).toBe(false);
  });
  it('is false when status is not active', () => {
    expect(isGrantActive(grant({ status: 'requested' }), now)).toBe(false);
  });
  it('treats a null expiry as non-expiring', () => {
    expect(isGrantActive(grant({ expires_at: null }), now)).toBe(true);
  });
});

describe('mergeGrantedPermissions', () => {
  it('unions base perms with active grants and dedupes', () => {
    const merged = mergeGrantedPermissions(
      ['ticket.read.own'],
      [grant(), grant({ granted_permissions: ['ticket.read.own', 'audit.read'] })],
      now,
    );
    expect(new Set(merged)).toEqual(new Set(['ticket.read.own', 'ticket.assign', 'audit.read']));
  });
  it('ignores expired grants', () => {
    const merged = mergeGrantedPermissions(['ticket.read.own'], [grant({ expires_at: '2020-01-01T00:00:00.000Z' })], now);
    expect(merged).toEqual(['ticket.read.own']);
  });
});
