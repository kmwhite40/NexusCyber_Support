import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import { bulkAction } from '../../src/modules/bulk.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('bulk ticket actions (integration)', () => {
  let agent: Principal;
  let acmeId: string;
  let ids: string[];

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
    const a = await createTicket(agent, { subject: 'Bulk target one', organizationId: acmeId, impact: 3, urgency: 3 });
    const b = await createTicket(agent, { subject: 'Bulk target two', organizationId: acmeId, impact: 3, urgency: 3 });
    ids = [a.id, b.id];
  });

  it('applies a tag across multiple tickets', async () => {
    const res = await bulkAction(agent, ids, 'tag', { tag: 'bulk-tagged' });
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(0);
    const tagged = await withSystemContext(async (sql) =>
      (await sql.query("SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1) AND 'bulk-tagged' = ANY(tags)", [ids])).rows[0].n,
    );
    expect(tagged).toBe(2);
  });

  it('reports per-ticket failures without aborting the batch', async () => {
    const res = await bulkAction(agent, [...ids, '00000000-0000-0000-0000-000000000000'], 'comment', { body: 'Bulk note', visibility: 'internal' });
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
  });
});
