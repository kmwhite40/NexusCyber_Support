import { describe, it, expect, beforeEach, vi } from 'vitest';

// suspendUser() (modules/accounts.ts) sets users.status = 'suspended', and NOTHING in the auth
// path looked at it: not loginLocal, not loadPrincipal, not the OIDC callback. So the admin
// "suspend" action in the /team page removed no access whatsoever — the user could still sign in
// with their password, and any session they already held kept working indefinitely.
//
// Both halves matter. Gating only the login leaves live sessions alive, which for a suspension
// (someone walked out, an account is compromised) is the case that actually matters.
const h = vi.hoisted(() => {
  let rows: (text: string, params: unknown[]) => any[] = () => [];
  const sql = { query: async (text: string, params: unknown[] = []) => ({ rows: rows(text, params) }) };
  return {
    sql,
    setRows: (fn: (text: string, params: unknown[]) => any[]) => { rows = fn; },
    withSystemContext: vi.fn(async (fn: any) => fn(sql)),
    activeGrantsFor: vi.fn(async () => []),
    mergeGrantedPermissions: vi.fn((perms: string[]) => perms),
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, pool: {} }));
vi.mock('../src/modules/elevation.js', () => ({
  activeGrantsFor: h.activeGrantsFor,
  mergeGrantedPermissions: h.mergeGrantedPermissions,
}));

const { loadPrincipal } = await import('../src/auth/principal.js');

const claims = {
  sub: '11111111-1111-1111-1111-111111111111',
  plane: 'nexus' as const,
  email: 'someone@sbsfederal.com',
  org: null,
  roles: [],
};

const withStatus = (status: string) => (text: string) => {
  if (/FROM users/.test(text)) return [{ status }];
  if (/role_assignments/.test(text)) return [{ role_key: 'Tier2', organization_id: null }];
  if (/role_permissions/.test(text)) return [{ permission_key: 'ticket.create' }];
  return [];
};

beforeEach(() => {
  vi.resetAllMocks();
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.activeGrantsFor.mockImplementation(async () => []);
  h.mergeGrantedPermissions.mockImplementation((perms: string[]) => perms);
});

describe('loadPrincipal and account status', () => {
  it('resolves an active user normally', async () => {
    h.setRows(withStatus('active'));
    const p = await loadPrincipal(claims);
    expect(p.permissions).toContain('ticket.create');
  });

  it('REFUSES a suspended user, killing sessions they already hold', async () => {
    // This is the half that matters most: without it, suspending someone leaves every token they
    // are already carrying valid until it expires on its own.
    h.setRows(withStatus('suspended'));
    await expect(loadPrincipal(claims)).rejects.toThrow(/suspend|not active/i);
  });

  it('refuses a user row that no longer exists', async () => {
    // A deleted user holding a live session should not keep their permissions either.
    h.setRows((text: string) => (/FROM users/.test(text) ? [] : []));
    await expect(loadPrincipal(claims)).rejects.toThrow();
  });

  it('checks status BEFORE doing the permission work', async () => {
    const seen: string[] = [];
    h.setRows((text: string) => {
      if (/FROM users/.test(text)) { seen.push('status'); return [{ status: 'suspended' }]; }
      if (/role_assignments/.test(text)) { seen.push('roles'); return []; }
      return [];
    });
    await expect(loadPrincipal(claims)).rejects.toThrow();
    expect(seen[0]).toBe('status');
  });
});
