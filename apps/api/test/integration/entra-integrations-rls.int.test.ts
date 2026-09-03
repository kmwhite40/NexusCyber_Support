import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext, withOrgContext } from '../../src/db/pool.js';

// A code review pointed out that the branch proved these RLS policies EXIST (a pg_policies
// lookup) without ever proving they isolate. Today every read goes through withSystemContext plus
// an explicit authorize() and an explicit WHERE organization_id — so the policy is a backstop
// nothing exercises, which is exactly the condition under which a typo in a copy-pasted policy
// survives review. These tables hold customer directory credentials; the backstop is worth
// testing directly.
const ORG_A = '00000000-0000-4000-8000-00000000a11a';
const ORG_B = '00000000-0000-4000-8000-00000000b22b';

const ctx = (orgId: string) => ({
  plane: 'customer' as const,
  orgId,
  assignedOrgs: [orgId],
  elevated: false,
  allOrgs: false,
  superuser: false,
});

describeDb('org_integrations tenant isolation', () => {
  beforeAll(async () => {
    await withSystemContext(async (sql) => {
      for (const [id, name] of [[ORG_A, 'RLS Fixture A'], [ORG_B, 'RLS Fixture B']]) {
        await sql.query(
          `INSERT INTO organizations (id, name, cloud, status) VALUES ($1,$2,'gcchigh','active')
           ON CONFLICT (id) DO NOTHING`, [id, name]);
        await sql.query(
          `INSERT INTO org_integrations
             (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag)
           VALUES ($1,'entra_graph',$2,'client','\\x01','\\x02','\\x03')
           ON CONFLICT (organization_id, provider) DO NOTHING`, [id, `tenant-of-${id}`]);
        await sql.query(
          `INSERT INTO integration_sync_runs (organization_id, provider, status)
           VALUES ($1,'entra_graph','ok')`, [id]);
      }
    });
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      for (const id of [ORG_A, ORG_B]) {
        await sql.query('DELETE FROM integration_sync_runs WHERE organization_id=$1', [id]);
        await sql.query('DELETE FROM org_integrations WHERE organization_id=$1', [id]);
        await sql.query('DELETE FROM organizations WHERE id=$1', [id]);
      }
    });
  });

  it('shows an org only its own integration row', async () => {
    const seen = await withOrgContext(ctx(ORG_A), async (sql) =>
      (await sql.query('SELECT organization_id FROM org_integrations')).rows
        .map((r: { organization_id: string }) => r.organization_id));
    expect(seen).toContain(ORG_A);
    expect(seen).not.toContain(ORG_B);
  });

  it('shows an org only its own sync-run history', async () => {
    const seen = await withOrgContext(ctx(ORG_B), async (sql) =>
      (await sql.query('SELECT organization_id FROM integration_sync_runs')).rows
        .map((r: { organization_id: string }) => r.organization_id));
    expect(seen).toContain(ORG_B);
    expect(seen).not.toContain(ORG_A);
  });

  it('refuses to let one org write credentials against another', async () => {
    // The WITH CHECK half of the policy. Without it a compromised or buggy customer-plane path
    // could point ANOTHER tenant's integration at an app registration it controls.
    await expect(withOrgContext(ctx(ORG_A), (sql) => sql.query(
      `INSERT INTO org_integrations
         (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1,'entra_graph_evil','t','c','\\x01','\\x02','\\x03')`, [ORG_B]),
    )).rejects.toThrow(/row-level security/i);
  });
});
