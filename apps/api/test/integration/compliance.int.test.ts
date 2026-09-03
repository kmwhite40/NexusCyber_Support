import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { controlCoverage, requestException, decideException } from '../../src/modules/compliance.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const user = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: user.id, plane: user.plane, email: user.email, org: user.organization_id, roles: [] });
}

describeDb('compliance (integration)', () => {
  let analyst: Principal; // nexus SecurityAnalyst (compliance.manage + approve_exception)
  let acmeId: string;

  beforeAll(async () => {
    analyst = await principalByEmail('analyst@nexus.example.com');
    acmeId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  it('computes control coverage for an org', async () => {
    const coverage = await controlCoverage(analyst, acmeId);
    expect(coverage.length).toBeGreaterThan(0);
    for (const c of coverage) expect(['satisfied', 'partial', 'gap']).toContain(c.status);
  });

  it('enforces separation of duties on exceptions', async () => {
    const finding = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id FROM posture_findings WHERE organization_id=$1 LIMIT 1', [acmeId])).rows[0],
    );
    const ex = await requestException(analyst, { findingId: finding.id, justification: 'compensating MFA in place', organizationId: acmeId });
    // same principal cannot approve their own request
    await expect(decideException(analyst, ex.id, true)).rejects.toThrow(/separation of duties/i);
  });
});
