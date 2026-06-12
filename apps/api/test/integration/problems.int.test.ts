import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createProblem, updateProblem, transitionProblem, linkIncident, getProblem } from '../../src/modules/problems.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('problem management (integration)', () => {
  let analyst: Principal;
  let acmeId: string;

  beforeAll(async () => {
    analyst = await principalByEmail('analyst@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Acme'")).rows[0].id);
  });

  it('creates a problem, records a known-error workaround, links an incident, and resolves', async () => {
    const prob = await createProblem(analyst, { title: 'Recurring VPN disconnects', organizationId: acmeId });
    expect(prob.status).toBe('open');

    await transitionProblem(analyst, prob.id, 'investigating');
    const updated = await updateProblem(analyst, prob.id, { rootCause: 'MTU misconfig on gateway', workaround: 'Lower client MTU to 1400', knownError: true });
    expect(updated.known_error).toBe(true);
    await transitionProblem(analyst, prob.id, 'known_error');

    const incident = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM tickets WHERE organization_id=$1 AND ticket_number='ACME-000003'", [acmeId])).rows[0],
    );
    await linkIncident(analyst, prob.id, incident.id);
    const full = await getProblem(analyst, prob.id);
    expect(full.incidents.find((i: any) => i.id === incident.id)).toBeTruthy();

    const res = await transitionProblem(analyst, prob.id, 'resolved');
    expect(res.status).toBe('resolved');
  });
});
