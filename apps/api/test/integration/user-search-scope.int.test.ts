import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { searchUsers } from '../../src/modules/accounts.js';
import { loadPrincipal } from '../../src/auth/principal.js';

// The MSP's own staff are nexus-plane with organization_id NULL. Every people picker searched
// `WHERE organization_id = $1`, so an agent could not find THEMSELVES to raise a request on
// behalf of — the field was required, the name was plainly visible elsewhere in the product, and
// the picker returned nothing. Reported as "almost like it can't find the requestor name".
describeDb('people-picker scope', () => {
  it('lets an agent find nexus-plane colleagues as well as the org roster', async () => {
    const { actor, orgId } = await withSystemContext(async (sql) => {
      const u = (await sql.query(
        "SELECT id, plane, email, organization_id FROM users WHERE plane='nexus' AND status='active' LIMIT 1")).rows[0];
      const o = (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0];
      return { actor: u, orgId: o.id as string };
    });
    if (!actor) return; // no nexus users seeded in this database
    const p = await loadPrincipal({ sub: actor.id, plane: actor.plane, email: actor.email, org: actor.organization_id, roles: [] });
    const hits = await searchUsers(p, actor.email.split('@')[0], orgId);
    expect(hits.some((h) => h.email === actor.email)).toBe(true);
  });

  it('does not let a customer user enumerate the provider staff', async () => {
    const cust = await withSystemContext(async (sql) => (await sql.query(
      "SELECT id, plane, email, organization_id FROM users WHERE plane='customer' AND status='active' AND organization_id IS NOT NULL LIMIT 1")).rows[0]);
    if (!cust) return;
    const p = await loadPrincipal({ sub: cust.id, plane: cust.plane, email: cust.email, org: cust.organization_id, roles: [] });
    const hits = await searchUsers(p, '', cust.organization_id);
    const planes = await withSystemContext(async (sql) => (await sql.query(
      'SELECT DISTINCT plane FROM users WHERE id = ANY($1)', [hits.map((h) => h.id)])).rows.map((r: { plane: string }) => r.plane));
    expect(planes).not.toContain('nexus');
  });
});
