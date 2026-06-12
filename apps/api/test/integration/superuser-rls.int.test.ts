import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listTickets } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('platform superuser cross-org (PDP + RLS consistency)', () => {
  let superAdmin: Principal;

  beforeAll(async () => {
    // Bootstrapped platform SuperAdmin (migration 0029), org-NULL role assignment.
    superAdmin = await principalByEmail('kevin.white@sbsfederal.com');
  });

  it('holds admin.superuser with NO assigned orgs', () => {
    expect(superAdmin.permissions).toContain('admin.superuser');
    expect(superAdmin.assignedOrgs).toEqual([]);
  });

  it('reads a tenant org it is not assigned to (RLS honors the superuser GUC)', async () => {
    // Demo Corp tickets exist; despite empty assignedOrgs, the superuser sees them because
    // app_is_nexus_in_scope() now allows the app.superuser GUC (0031). Without that fix RLS
    // would return zero rows.
    const tickets = await listTickets(superAdmin, { limit: 5 });
    expect(tickets.length).toBeGreaterThan(0);
  });
});
