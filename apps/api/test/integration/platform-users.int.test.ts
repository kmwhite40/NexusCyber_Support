// Real-Postgres coverage for Platform User Administration (modules/platform-users.ts) and the
// staff/customer "twin" problem that locked ajdin.karic out on 2026-09-24:
//  - an empty per-org scope used to delete every role assignment and report success;
//  - a delegated admin could reset a SuperAdmin's password or rewrite their roles;
//  - a staff account could not take over the Entra identity the roster sync had put on the
//    same person's customer row (users.external_id is globally UNIQUE);
//  - there was no way to delete an account at all.
import { randomUUID } from 'node:crypto';
import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import type { Principal } from '../../src/types.js';

const pu = await import('../../src/modules/platform-users.js');
const accounts = await import('../../src/modules/accounts.js');

const tag = randomUUID().slice(0, 8);
const mail = (n: string) => `${n}-${tag}@pu-test.invalid`;

function principal(over: Partial<Principal> & { id: string }): Principal {
  return {
    plane: 'nexus', email: 'x@pu-test.invalid', displayName: null, organizationId: null,
    roles: [], permissions: ['admin.users.manage'], assignedOrgs: [], allOrgs: false, elevated: false,
    ...over,
  };
}

async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return withSystemContext(async (sql) => (await sql.query(text, params)).rows as T[]);
}

async function rolesOf(userId: string) {
  return q<{ key: string; organization_id: string | null }>(
    `SELECT r.key, ra.organization_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1 ORDER BY 1`,
    [userId],
  );
}

describeDb('platform user administration (real Postgres)', () => {
  let orgA: string;
  let orgB: string;
  let superActor: Principal;
  let delegated: Principal;
  let superTarget: string;

  beforeAll(async () => {
    orgA = (await q(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`PU A ${tag}`]))[0].id;
    orgB = (await q(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`PU B ${tag}`]))[0].id;
    const sa = (await q(`INSERT INTO users (plane, email) VALUES ('nexus', $1) RETURNING id`, [mail('actor-super')]))[0].id;
    const dm = (await q(`INSERT INTO users (plane, email) VALUES ('nexus', $1) RETURNING id`, [mail('actor-sdm')]))[0].id;
    superActor = principal({ id: sa, permissions: ['admin.users.manage', 'admin.superuser'], allOrgs: true });
    delegated = principal({ id: dm, assignedOrgs: [orgA] });
    superTarget = (await pu.createPlatformUser(superActor, {
      email: mail('target-super'), roleKeys: ['SuperAdmin'], scope: { mode: 'orgs', orgIds: [orgA] },
    })).id;
  });

  afterAll(async () => {
    await q(`DELETE FROM tickets WHERE organization_id IN ($1, $2)`, [orgA, orgB]);
    await q(`DELETE FROM role_assignments WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1 OR email LIKE 'deleted+%@deleted.invalid' AND display_name LIKE $1)`, [`%-${tag}@pu-test.invalid%`]);
    await q(`DELETE FROM users WHERE email LIKE $1 OR (email LIKE 'deleted+%@deleted.invalid' AND display_name LIKE $1)`, [`%-${tag}@pu-test.invalid%`]);
    await q(`DELETE FROM organizations WHERE id IN ($1, $2)`, [orgA, orgB]);
  });

  it('refuses an empty org scope instead of silently stripping every role', async () => {
    await expect(pu.createPlatformUser(superActor, {
      email: mail('empty-scope'), roleKeys: ['Tier2'], scope: { mode: 'orgs', orgIds: [] },
    })).rejects.toMatchObject({ status: 400 });
    expect(await q(`SELECT 1 FROM users WHERE email = $1`, [mail('empty-scope')])).toHaveLength(0);

    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('keeps-roles'), roleKeys: ['Tier2'], scope: { mode: 'orgs', orgIds: [orgA] },
    });
    await expect(pu.setPlatformUserAccess(superActor, id, { roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [] } }))
      .rejects.toMatchObject({ status: 400 });
    expect((await rolesOf(id)).map((r) => r.key)).toEqual(['Tier2']);
  });

  it('rolls a role rewrite back as a whole when part of it is invalid', async () => {
    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('atomic'), roleKeys: ['Tier2'], scope: { mode: 'orgs', orgIds: [orgA] },
    });
    await expect(pu.setPlatformUserAccess(superActor, id, { roleKeys: ['Tier1', 'NoSuchRole'], scope: { mode: 'orgs', orgIds: [orgA] } }))
      .rejects.toMatchObject({ status: 400 });
    expect((await rolesOf(id)).map((r) => r.key)).toEqual(['Tier2']);
  });

  it('writes the all-organizations grant as org-NULL rows', async () => {
    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('all-orgs'), roleKeys: ['Tier1', 'Tier2'], scope: { mode: 'all' },
    });
    const rows = await rolesOf(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.organization_id === null)).toBe(true);
  });

  it('stops a delegated admin from touching a SuperAdmin at all', async () => {
    await expect(pu.updatePlatformUser(delegated, superTarget, { password: 'a-new-password-123' }))
      .rejects.toMatchObject({ status: 403 });
    await expect(pu.setPlatformUserAccess(delegated, superTarget, { roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] } }))
      .rejects.toMatchObject({ status: 403 });
    await expect(pu.deletePlatformUser(delegated, superTarget)).rejects.toMatchObject({ status: 403 });
    expect((await rolesOf(superTarget)).map((r) => r.key)).toEqual(['SuperAdmin']);
  });

  it('stops a delegated admin from managing a user outside their orgs', async () => {
    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('org-b'), roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgB] },
    });
    await expect(pu.updatePlatformUser(delegated, id, { status: 'suspended' })).rejects.toMatchObject({ status: 403 });
    const inScope = (await pu.createPlatformUser(superActor, {
      email: mail('org-a'), roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] },
    })).id;
    await expect(pu.updatePlatformUser(delegated, inScope, { status: 'suspended' })).resolves.toEqual({ id: inScope });
  });

  it('takes over the Entra identity of the same person\'s customer account', async () => {
    const oid = randomUUID();
    const twin = (await q(
      `INSERT INTO users (plane, organization_id, email, external_id) VALUES ('customer', $1, $2, $3) RETURNING id`,
      [orgA, mail('twin'), oid],
    ))[0].id;
    const r = await pu.createPlatformUser(superActor, {
      email: mail('twin'), roleKeys: ['Tier2'], scope: { mode: 'all' },
    });
    expect(r.releasedCustomerAccount).toBe(true);
    const [staff] = await q(`SELECT external_id FROM users WHERE id = $1`, [r.id]);
    const [cust] = await q(`SELECT status, external_id FROM users WHERE id = $1`, [twin]);
    expect(staff.external_id).toBe(oid);
    expect(cust).toEqual({ status: 'suspended', external_id: null });
  });

  it('refuses to let an admin delete, suspend or demote themselves', async () => {
    const self = (await pu.createPlatformUser(superActor, {
      email: mail('self'), roleKeys: ['SuperAdmin'], scope: { mode: 'all' },
    })).id;
    const me = principal({ id: self, permissions: ['admin.users.manage', 'admin.superuser'], allOrgs: true });
    await expect(pu.deletePlatformUser(me, self)).rejects.toMatchObject({ status: 403 });
    await expect(pu.updatePlatformUser(me, self, { status: 'suspended' })).rejects.toMatchObject({ status: 403 });
    await expect(pu.setPlatformUserAccess(me, self, { roleKeys: ['Tier1'], scope: { mode: 'all' } }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('hard-deletes an account with no history', async () => {
    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('fresh'), roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] },
    });
    await expect(pu.deletePlatformUser(superActor, id)).resolves.toEqual({ id, mode: 'deleted' });
    expect(await q(`SELECT 1 FROM users WHERE id = $1`, [id])).toHaveLength(0);
    expect(await rolesOf(id)).toHaveLength(0);
  });

  it('tombstones an account that has history, freeing its email and Entra link', async () => {
    const { id } = await pu.createPlatformUser(superActor, {
      email: mail('history'), displayName: `History ${tag}-${tag}@pu-test.invalid`, roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] },
    });
    await q(`UPDATE users SET external_id = $2 WHERE id = $1`, [id, randomUUID()]);
    await q(
      `INSERT INTO tickets (organization_id, ticket_number, subject, requester_id) VALUES ($1, $2, 'x', $3)`,
      [orgA, `PU-${tag}`, id],
    );
    await expect(pu.deletePlatformUser(superActor, id)).resolves.toEqual({ id, mode: 'tombstoned' });
    const [u] = await q(`SELECT status, email, external_id, password_hash FROM users WHERE id = $1`, [id]);
    expect(u.status).toBe('deleted');
    expect(u.email).toBe(`deleted+${id}@deleted.invalid`);
    expect(u.external_id).toBeNull();
    expect(await rolesOf(id)).toHaveLength(0);
    expect((await pu.listPlatformUsers()).some((x) => x.id === id)).toBe(false);
    // The address is free again: the person can be re-created.
    const again = await pu.createPlatformUser(superActor, {
      email: mail('history'), roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] },
    });
    expect(again.id).not.toBe(id);
  });
  // The crash that actually locked ajdin.karic out: staff Microsoft sign-in tried to copy the
  // Entra oid onto the staff row while the roster-synced customer row still held it (UNIQUE).
  it('staff Microsoft sign-in takes the Entra identity over from the customer twin', async () => {
    const oid = randomUUID();
    const email = mail('sso-twin');
    const twin = (await q(
      `INSERT INTO users (plane, organization_id, email, external_id) VALUES ('customer', $1, $2, $3) RETURNING id`,
      [orgA, email, oid],
    ))[0].id;
    // Hand-made staff account, no Entra link yet — exactly the /team-created shape.
    const staff = (await pu.createPlatformUser(superActor, {
      email: mail('sso-twin-staff'), roleKeys: ['SuperAdmin'], scope: { mode: 'all' },
    })).id;
    await q(`UPDATE users SET email = $2 WHERE id = $1`, [staff, email]);

    const r = await accounts.loginOrProvisionAgentOidc({ oid, email, displayName: 'SSO Twin', appRoles: [] });
    expect(r.principal.id).toBe(staff);
    expect(r.principal.permissions).toContain('admin.superuser');
    const [s] = await q(`SELECT external_id FROM users WHERE id = $1`, [staff]);
    const [c] = await q(`SELECT status, external_id FROM users WHERE id = $1`, [twin]);
    expect(s.external_id).toBe(oid);
    expect(c).toEqual({ status: 'suspended', external_id: null });
  });

  it('staff Microsoft sign-in with no app role and no staff account is refused without touching the twin', async () => {
    const oid = randomUUID();
    const email = mail('sso-norole');
    const twin = (await q(
      `INSERT INTO users (plane, organization_id, email, external_id) VALUES ('customer', $1, $2, $3) RETURNING id`,
      [orgA, email, oid],
    ))[0].id;
    await expect(accounts.loginOrProvisionAgentOidc({ oid, email, displayName: null, appRoles: [] }))
      .rejects.toMatchObject({ status: 403 });
    const [c] = await q(`SELECT status, external_id FROM users WHERE id = $1`, [twin]);
    expect(c).toEqual({ status: 'active', external_id: oid });
  });

  it('local password sign-in picks the staff account over a password-less customer twin', async () => {
    const email = mail('pw-twin');
    await q(`INSERT INTO users (plane, organization_id, email) VALUES ('customer', $1, $2)`, [orgA, email]);
    const staff = (await pu.createPlatformUser(superActor, {
      email: mail('pw-twin-staff'), roleKeys: ['Tier1'], scope: { mode: 'orgs', orgIds: [orgA] }, password: 'correct-horse-battery',
    })).id;
    await q(`UPDATE users SET email = $2 WHERE id = $1`, [staff, email]);
    for (let i = 0; i < 5; i++) {
      const r = await accounts.loginLocal(email, 'correct-horse-battery');
      expect(r.principal.id).toBe(staff);
    }
  });
});
