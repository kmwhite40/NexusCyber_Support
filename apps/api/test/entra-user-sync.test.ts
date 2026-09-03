import { describe, it, expect, vi } from 'vitest';
import { isStaffAccount, mapEntraUser, applyUserSync } from '../src/integrations/entra/user-sync.js';

const u = (o: Record<string, unknown> = {}) => ({
  id: 'oid-1', userPrincipalName: 'ada.lovelace@sbsfederal.com', displayName: 'Lovelace, Ada',
  givenName: 'Ada', surname: 'Lovelace', userType: 'Member',
  accountEnabled: true, assignedLicenses: [{ skuId: 'e3' }], ...o,
});

describe('isStaffAccount', () => {
  const D = 'sbsfederal.com';
  it('accepts a licensed member on the domain', () => expect(isStaffAccount(u(), D)).toBe(true));
  it('rejects guests', () => expect(isStaffAccount(u({ userType: 'Guest' }), D)).toBe(false));
  it('rejects other domains', () => expect(isStaffAccount(u({ userPrincipalName: 'x@other.gov' }), D)).toBe(false));
  // 51 of the tenant's members are unlicensed: shared mailboxes, resource and service accounts.
  // They are not people, and putting them in the offboarding picker would be noise at best.
  it('rejects unlicensed members', () => expect(isStaffAccount(u({ assignedLicenses: [] }), D)).toBe(false));
  it('is case-insensitive about the domain', () =>
    expect(isStaffAccount(u({ userPrincipalName: 'Andrew.Dean@SBSFederal.com' }), D)).toBe(true));
});

/** A fake sql that records writes and answers lookups from a small in-memory table. */
function fakeSql(existing: Array<{ id: string; email: string; plane: string; external_id: string | null; status: string }>) {
  const inserted: any[] = [];
  const linked: any[] = [];
  const suspended: string[] = [];
  const roles: any[] = [];
  const query = vi.fn(async (text: string, params: any[] = []) => {
    if (/SELECT id, plane, organization_id FROM users WHERE external_id/.test(text)) {
      const r = existing.find((e) => e.external_id === params[0]);
      return { rows: r ? [{ ...r, organization_id: (r as any).organization_id ?? 'org-1' }] : [] };
    }
    if (/SELECT id, plane, external_id FROM users\s+WHERE organization_id/.test(text)) {
      const r = existing.find((e) => e.email === params[1]);
      return { rows: r ? [r] : [] };
    }
    if (/UPDATE users SET external_id/.test(text)) { linked.push(params); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO users/.test(text)) { inserted.push(params); return { rows: [{ id: 'new-' + inserted.length }] }; }
    if (/INSERT INTO role_assignments/.test(text)) { roles.push(params); return { rows: [] }; }
    if (/SELECT id, email, external_id FROM users/.test(text)) {
      return { rows: existing.filter((e) => e.plane === 'customer' && e.external_id && e.status === 'active') };
    }
    if (/UPDATE users SET status='suspended'/.test(text)) { suspended.push(params[0]); return { rows: [] }; }
    return { rows: [] };
  });
  return { sql: { query } as any, inserted, linked, suspended, roles };
}

describe('applyUserSync', () => {
  const ORG = 'org-1';

  it('creates a user that does not exist yet, with the default role', async () => {
    const f = fakeSql([]);
    const stats = await applyUserSync(f.sql, ORG, [mapEntraUser(u())!], 'EndUser');
    expect(stats.created).toBe(1);
    expect(f.inserted).toHaveLength(1);
    expect(f.roles).toHaveLength(1);
  });

  // THE RULE THE OPERATOR ASKED FOR. The two people already in this org arrived via SSO and are
  // already linked by Entra oid; a second record for the same human would put them in the
  // offboarding picker twice, with no way to tell which one is real.
  it('does NOT duplicate a user already linked by Entra oid', async () => {
    const f = fakeSql([{ id: 'u1', email: 'ada.lovelace@sbsfederal.com', plane: 'customer', external_id: 'oid-1', status: 'active' }]);
    const stats = await applyUserSync(f.sql, ORG, [mapEntraUser(u())!], 'EndUser');
    expect(stats.created).toBe(0);
    expect(f.inserted).toEqual([]);
  });

  // Someone hand-created before SSO, or created on a different plane, still must not be doubled.
  it('links an existing account matched by email instead of inserting a second one', async () => {
    const f = fakeSql([{ id: 'u2', email: 'ada.lovelace@sbsfederal.com', plane: 'customer', external_id: null, status: 'active' }]);
    const stats = await applyUserSync(f.sql, ORG, [mapEntraUser(u())!], 'EndUser');
    expect(stats.created).toBe(0);
    expect(stats.linked).toBe(1);
    expect(f.inserted).toEqual([]);
    expect(f.linked[0]).toEqual(['oid-1', 'u2']);
  });


  // FOUND AGAINST REAL DATA. users.external_id is globally UNIQUE, and several SBS staff are also
  // Nexus operators who signed in via agent SSO — so their Entra oid was already taken. An
  // org-scoped lookup missed those rows and the import died on a duplicate key halfway through.
  it('leaves an operator account alone rather than duplicating the person', async () => {
    const f = fakeSql([{ id: 'op1', email: 'ada.lovelace@sbsfederal.com', plane: 'nexus', external_id: 'oid-1', status: 'active' } as any]);
    const stats = await applyUserSync(f.sql, ORG, [mapEntraUser(u())!], 'EndUser');
    expect(stats.created).toBe(0);
    expect(stats.skippedExisting).toBe(1);
    expect(f.inserted).toEqual([]);
    expect(f.linked).toEqual([]);
  });

  it('suspends a synced user who has left the tenant, never deletes them', async () => {
    const f = fakeSql([
      { id: 'u1', email: 'ada.lovelace@sbsfederal.com', plane: 'customer', external_id: 'oid-1', status: 'active' },
      { id: 'gone', email: 'left@sbsfederal.com', plane: 'customer', external_id: 'oid-gone', status: 'active' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, email: `k${i}@sbsfederal.com`, plane: 'customer', external_id: `oid-k${i}`, status: 'active' })),
    ]);
    const seen = [mapEntraUser(u())!, ...Array.from({ length: 20 }, (_, i) =>
      mapEntraUser(u({ id: `oid-k${i}`, userPrincipalName: `k${i}@sbsfederal.com` }))!)];
    const stats = await applyUserSync(f.sql, ORG, seen, 'EndUser');
    expect(f.suspended).toEqual(['gone']);
    expect(stats.suspended).toBe(1);
  });

  // The device sync shipped a silent mass-retirement bug. Same failure shape, higher stakes:
  // suspending a workforce locks everyone out of the portal at once.
  it('refuses to suspend anyone when the tenant returns nobody', async () => {
    const f = fakeSql(Array.from({ length: 12 }, (_, i) =>
      ({ id: `u${i}`, email: `u${i}@sbsfederal.com`, plane: 'customer', external_id: `oid-${i}`, status: 'active' })));
    const stats = await applyUserSync(f.sql, ORG, [], 'EndUser');
    expect(stats.skippedSuspension).toBe(true);
    expect(f.suspended).toEqual([]);
  });

  it('refuses a run that would suspend most of the organization', async () => {
    const f = fakeSql(Array.from({ length: 20 }, (_, i) =>
      ({ id: `u${i}`, email: `u${i}@sbsfederal.com`, plane: 'customer', external_id: `oid-${i}`, status: 'active' })));
    const seen = [mapEntraUser(u({ id: 'oid-0', userPrincipalName: 'u0@sbsfederal.com' }))!];
    const stats = await applyUserSync(f.sql, ORG, seen, 'EndUser');
    expect(stats.skippedSuspension).toBe(true);
    expect(f.suspended).toEqual([]);
  });
});
