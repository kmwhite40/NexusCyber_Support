import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listDashboards, createDashboard, deleteDashboard } from '../../src/modules/dashboards.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('dashboards (integration)', () => {
  let manager: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('lists the seeded default dashboard', async () => {
    const list = await listDashboards(manager);
    expect(list.some((d: any) => d.is_default && d.name === 'Operations overview')).toBe(true);
  });

  it('create sanitizes the layout to known widget types only', async () => {
    const d = await createDashboard(manager, { name: 'Int board', layout: [{ type: 'kpis' }, { type: 'bogus' }, { type: 'top_findings' }] as any, organizationId: orgId });
    expect(d.layout).toEqual([{ type: 'kpis' }, { type: 'top_findings' }]);
  });

  it('cannot delete the default dashboard', async () => {
    const list = await listDashboards(manager);
    const def = list.find((d: any) => d.is_default);
    await expect(deleteDashboard(manager, def.id)).rejects.toThrow();
  });
});
