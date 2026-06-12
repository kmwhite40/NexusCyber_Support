import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listServices, createService, listConfigurationItems, createConfigurationItem } from '../../src/modules/services.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('services/CMDB (integration)', () => {
  let manager: Principal;
  let enduser: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    enduser = await principalByEmail('user@demo.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('manager can create a service and a CI, and list returns them with ticket_count', async () => {
    const svc = await createService(manager, { name: 'Test API', kind: 'application', organizationId: orgId });
    expect(svc.id).toBeTruthy();
    const ci = await createConfigurationItem(manager, { name: 'db-int-01', ciClass: 'database', criticality: 'high', organizationId: orgId });
    expect(ci.id).toBeTruthy();
    const services = await listServices(manager);
    expect(services.some((s: any) => s.id === svc.id)).toBe(true);
    expect(services.find((s: any) => s.id === svc.id)).toHaveProperty('ticket_count');
    const cis = await listConfigurationItems(manager, {});
    expect(cis.some((c: any) => c.id === ci.id)).toBe(true);
  });

  it('a customer end-user (no service.manage) is denied create', async () => {
    await expect(createService(enduser, { name: 'Nope', organizationId: orgId })).rejects.toThrow();
  });
});
