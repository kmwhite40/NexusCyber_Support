// A customer OrgAdmin could make themselves platform SuperAdmin: provisionUser and
// updateOrgUserAdmin accepted any role key, and loadPrincipal granted a role's permissions
// regardless of plane. Chained with public signup, that was a full-platform takeover from the
// internet. Both halves are closed; this proves each independently against real Postgres.
import { randomUUID } from 'node:crypto';
import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import type { Principal } from '../../src/types.js';

const accounts = await import('../../src/modules/accounts.js');
const { loadPrincipal } = await import('../../src/auth/principal.js');

const tag = randomUUID().slice(0, 8);
async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return withSystemContext(async (sql) => (await sql.query(text, params)).rows as T[]);
}

describeDb('customer role escalation (real Postgres)', () => {
  let org: string;
  let admin: Principal;
  let adminId: string;

  beforeAll(async () => {
    org = (await q(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Esc ${tag}`]))[0].id;
    adminId = (await q(
      `INSERT INTO users (plane, organization_id, email) VALUES ('customer', $1, $2) RETURNING id`,
      [org, `admin-${tag}@esc.invalid`],
    ))[0].id;
    await q(`INSERT INTO role_assignments (user_id, role_id, organization_id) SELECT $1, id, $2 FROM roles WHERE key='OrgAdmin'`, [adminId, org]);
    admin = await loadPrincipal({ sub: adminId, plane: 'customer', email: `admin-${tag}@esc.invalid`, org, roles: ['OrgAdmin'] } as any);
  });

  afterAll(async () => {
    await q(`DELETE FROM role_assignments WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)`, [org]);
    await q(`DELETE FROM users WHERE organization_id = $1`, [org]);
    await q(`DELETE FROM organizations WHERE id = $1`, [org]);
  });

  it('an OrgAdmin cannot promote themselves to a staff role', async () => {
    for (const roleKey of ['SuperAdmin', 'ServiceDeskManager', 'Tier2']) {
      await expect(accounts.updateOrgUserAdmin(admin, org, adminId, { roleKey })).rejects.toThrow(/not a customer role/);
    }
    const keys = (await q(`SELECT r.key FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.user_id=$1`, [adminId])).map((r) => r.key);
    expect(keys).toEqual(['OrgAdmin']);
  });

  it('an OrgAdmin cannot create a user with a staff role', async () => {
    await expect(accounts.provisionUser(admin, org, { email: `new-${tag}@esc.invalid`, roleKey: 'SuperAdmin' }))
      .rejects.toThrow(/not a customer role/);
    expect(await q(`SELECT 1 FROM users WHERE email = $1`, [`new-${tag}@esc.invalid`])).toHaveLength(0);
  });

  it('a staff role on a customer user confers nothing', async () => {
    const victim = (await q(
      `INSERT INTO users (plane, organization_id, email) VALUES ('customer', $1, $2) RETURNING id`,
      [org, `planted-${tag}@esc.invalid`],
    ))[0].id;
    await q(`INSERT INTO role_assignments (user_id, role_id, organization_id) SELECT $1, id, $2 FROM roles WHERE key='SuperAdmin'`, [victim, org]);
    const p = await loadPrincipal({ sub: victim, plane: 'customer', email: 'x', org, roles: [] } as any);
    expect(p.permissions).not.toContain('admin.superuser');
    expect(p.roles).not.toContain('SuperAdmin');
  });

  it('public signup is refused when self-service signup is disabled', async () => {
    const { config } = await import('../../src/config.js');
    const prev = config.selfSignupEnabled;
    (config as { selfSignupEnabled: boolean }).selfSignupEnabled = false;
    try {
      await expect(accounts.registerCustomer({ organizationName: `Evil ${tag}`, email: `evil-${tag}@esc.invalid`, password: 'long-enough-password' }))
        .rejects.toMatchObject({ status: 403 });
    } finally {
      (config as { selfSignupEnabled: boolean }).selfSignupEnabled = prev;
    }
  });
});
