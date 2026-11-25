// Risk acceptance packages against a live Postgres: issue, reprint, void, one package per risk,
// and organization separation.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import * as risks from '../../src/modules/risks.js';
import * as pkgs from '../../src/modules/acceptance-packages.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const OTHER_ORG = 'Package Isolation Test Org';
const OTHER_ADMIN = 'package-isolation-admin@other.example';
const future = () => new Date(Date.now() + 90 * 86_400_000).toISOString();

describeDb('risk acceptance packages (integration)', () => {
  let analyst: Principal;
  let manager: Principal;
  let otherAdmin: Principal;
  let demoId: string;
  let otherId: string;

  /** A risk of `actor`'s register with an acceptance awaiting a decision. */
  async function requested(actor: Principal, orgId: string | undefined, title: string) {
    const r = await risks.createRisk(actor, { organizationId: orgId, title, inherentLikelihood: 4, inherentImpact: 4, residualLikelihood: 3, residualImpact: 4 });
    await risks.requestAcceptance(actor, r.id, { justification: `Business needs ${title}`, expiresAt: future() });
    return r;
  }

  async function cleanPackages() {
    await withSystemContext(async (sql) => {
      await sql.query('DELETE FROM risk_acceptance_packages WHERE organization_id = ANY($1::uuid[])', [[demoId, otherId]]);
    });
  }

  beforeAll(async () => {
    analyst = await principalByEmail('analyst@nexus.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
    demoId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
    otherId = await withSystemContext(async (sql) => {
      const existing = (await sql.query('SELECT id FROM organizations WHERE name=$1', [OTHER_ORG])).rows[0];
      const id = existing?.id ?? (await sql.query(
        `INSERT INTO organizations (name, cloud, enclave_id, status) VALUES ($1,'commercial','commercial','active') RETURNING id`, [OTHER_ORG],
      )).rows[0].id;
      const u = (await sql.query(
        `INSERT INTO users (plane, organization_id, email, display_name) VALUES ('customer',$1,$2,'Other Admin')
         ON CONFLICT (plane, email) DO UPDATE SET organization_id=EXCLUDED.organization_id RETURNING id`, [id, OTHER_ADMIN],
      )).rows[0].id;
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id) SELECT $1, r.id, $2 FROM roles r WHERE r.key='OrgAdmin' ON CONFLICT DO NOTHING`,
        [u, id],
      );
      return id;
    });
    otherAdmin = await principalByEmail(OTHER_ADMIN);
    // Demo Corp's register carries requested acceptances from other suites; start from a clean slate.
    await cleanPackages();
    await withSystemContext(async (sql) => {
      await sql.query("UPDATE risks SET acceptance_status='none' WHERE organization_id=$1 AND acceptance_status='requested'", [demoId]);
    });
  });

  afterAll(async () => {
    await cleanPackages();
    await withSystemContext(async (sql) => {
      await sql.query("DELETE FROM users WHERE email=$1", [OTHER_ADMIN]);
      await sql.query('DELETE FROM organizations WHERE name=$1', [OTHER_ORG]);
    });
  });

  it('issues a package of the org\'s requested risks', async () => {
    await cleanPackages();
    const a = await requested(analyst, demoId, 'Pkg: issue A');
    const b = await requested(analyst, demoId, 'Pkg: issue B');
    const s = await pkgs.issuePackage(analyst, { organizationId: demoId, reference: 'RA-TEST' });
    expect(s.number).toBe('AP-0001');
    expect(s.status).toBe('issued');
    expect([...s.risk_ids].sort()).toEqual([a.id, b.id].sort());
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s).not.toHaveProperty('html');
    const { html, packageNumber } = await pkgs.getPackageHtml(analyst, s.id);
    expect(packageNumber).toBe('AP-0001');
    expect(html).toContain(a.ref);
    expect(html).toContain(b.ref);
    expect(html).toContain('RA-TEST');
    expect(html).toContain(s.sha256.slice(0, 12));
    expect((await pkgs.listPackages(analyst, demoId)).map((p) => p.id)).toContain(s.id);
  });

  it('reprint is identical after the risk changes', async () => {
    await cleanPackages();
    const a = await requested(analyst, demoId, 'Pkg: reprint');
    const s = await pkgs.issuePackage(analyst, { organizationId: demoId });
    const first = (await pkgs.getPackageHtml(analyst, s.id)).html;
    await risks.updateRisk(analyst, a.id, { title: 'Pkg: reprint CHANGED', residualLikelihood: 1 });
    const second = (await pkgs.getPackageHtml(analyst, s.id)).html;
    expect(second).toBe(first);
    expect(second).not.toContain('CHANGED');
  });

  it('refuses risks of another organization', async () => {
    await cleanPackages();
    const mine = await requested(analyst, demoId, 'Pkg: mine');
    const theirs = await requested(otherAdmin, undefined, 'Pkg: theirs');
    await expect(pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [mine.id, theirs.id] })).rejects.toMatchObject({ status: 400 });
    await pkgs.issuePackage(analyst, { organizationId: demoId });
    const all = await withSystemContext(async (sql) =>
      (await sql.query('SELECT html FROM risk_acceptance_packages WHERE organization_id=$1', [demoId])).rows,
    );
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.html).not.toContain(OTHER_ORG);
      expect(row.html).not.toContain('Pkg: theirs');
    }
  });

  it('refuses risks not awaiting acceptance', async () => {
    await cleanPackages();
    const t = await risks.createRisk(analyst, { organizationId: demoId, title: 'Pkg: treating', inherentLikelihood: 3, inherentImpact: 3, residualLikelihood: 3, residualImpact: 3 });
    await risks.transitionRisk(analyst, t.id, 'treating');
    await requested(analyst, demoId, 'Pkg: awaiting');
    await expect(pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [t.id] })).rejects.toMatchObject({ status: 400 });
  });

  it('a risk is in at most one issued package', async () => {
    await cleanPackages();
    const a = await requested(analyst, demoId, 'Pkg: once');
    const first = await pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [a.id] });
    await expect(pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [a.id] })).rejects.toMatchObject({ status: 409 });
    await expect(pkgs.issuePackage(analyst, { organizationId: demoId })).rejects.toMatchObject({ status: 409 });
    const voided = await pkgs.voidPackage(analyst, first.id, 'Issued in error');
    expect(voided.status).toBe('void');
    await expect(pkgs.voidPackage(analyst, first.id, 'Again')).rejects.toMatchObject({ status: 409 });
    const second = await pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [a.id] });
    expect(second.number).toBe('AP-0002');
  });

  it('concurrent issue gives the risk to one package', async () => {
    await cleanPackages();
    const a = await requested(analyst, demoId, 'Pkg: race');
    const results = await Promise.allSettled([
      pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [a.id] }),
      pkgs.issuePackage(analyst, { organizationId: demoId, riskIds: [a.id] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
  });

  it('staff must name the organization', async () => {
    await expect(pkgs.listPackages(manager)).rejects.toMatchObject({ status: 400 });
    await expect(pkgs.issuePackage(manager, {})).rejects.toMatchObject({ status: 400 });
  });

  it('customer of another org cannot list or print', async () => {
    await cleanPackages();
    await requested(analyst, demoId, 'Pkg: private');
    const s = await pkgs.issuePackage(analyst, { organizationId: demoId });
    await expect(pkgs.listPackages(otherAdmin, demoId)).rejects.toMatchObject({ status: 403 });
    await expect(pkgs.getPackageHtml(otherAdmin, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(pkgs.voidPackage(otherAdmin, s.id, 'sneaky')).rejects.toMatchObject({ status: 404 });
    expect(await pkgs.listPackages(otherAdmin)).toEqual([]);
  });

  it('audits issue, export and void', async () => {
    await cleanPackages();
    await requested(analyst, demoId, 'Pkg: audit');
    const s = await pkgs.issuePackage(analyst, { organizationId: demoId });
    await pkgs.getPackageHtml(analyst, s.id);
    await pkgs.voidPackage(analyst, s.id, 'Audit check');
    const actions = await withSystemContext(async (sql) =>
      (await sql.query('SELECT action FROM audit_logs WHERE resource_id=$1', [s.id])).rows.map((r: any) => r.action),
    );
    expect(actions).toEqual(expect.arrayContaining([
      'risk.acceptance_package.issue', 'risk.acceptance_package.export', 'risk.acceptance_package.void',
    ]));
  });
});
