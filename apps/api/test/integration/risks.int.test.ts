// Risk register against a live Postgres: lifecycle, acceptance SoD, links, and — the headline —
// organization separation enforced through PDP + RLS together.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import * as risks from '../../src/modules/risks.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const OTHER_ORG = 'Risk Isolation Test Org';
const OTHER_ADMIN = 'risk-isolation-admin@other.example';

describeDb('risk register (integration)', () => {
  let analyst: Principal;   // SecurityAnalyst, assigned to Demo Corp only — risk.manage, no risk.accept
  let manager: Principal;   // ServiceDeskManager — risk.accept
  let otherAdmin: Principal; // OrgAdmin of a different organization
  let demoId: string;
  let otherId: string;

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
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      await sql.query("DELETE FROM users WHERE email=$1", [OTHER_ADMIN]);
      await sql.query('DELETE FROM organizations WHERE name=$1', [OTHER_ORG]);
    });
  });

  it('creates, scores, numbers per organization and records history', async () => {
    const a = await risks.createRisk(analyst, {
      organizationId: demoId, title: 'Integration: unpatched VPN appliance',
      inherentLikelihood: 4, inherentImpact: 4, residualLikelihood: 3, residualImpact: 4,
      impactDimensions: { confidentiality: 5, availability: 3 },
      fair: { lef: { min: 0.1, likely: 0.4, max: 1 }, lm: { min: 10_000, likely: 50_000, max: 400_000 } },
    });
    // High-water mark of the dimensions overrides the direct inherent impact.
    expect(a.inherent_impact).toBe(5);
    expect(a.inherent_score).toBe(20);
    expect(a.residual_score).toBe(12);
    expect(a.status).toBe('assessed');
    expect(a.ref).toMatch(/^R-\d{4}$/);
    expect(a.fair_results.p50).toBeGreaterThan(0);

    // A second org's numbering starts at its own R-0001: numbers never leak tenant volume.
    const b = await risks.createRisk(otherAdmin, { title: 'Integration: other org risk', inherentLikelihood: 2, inherentImpact: 2 });
    expect(b.organization_id).toBe(otherId);
    expect(b.ref).toBe('R-0001');
    expect(b.status).toBe('identified');

    const full = await risks.getRisk(analyst, a.id);
    expect(full.history[0].kind).toBe('created');
    expect(full.settings.organization_id).toBe(demoId);
  });

  it('keeps each organization\'s register separate (PDP + RLS)', async () => {
    const theirs = (await risks.listRisks(otherAdmin, undefined)).find((r: any) => r.title === 'Integration: other org risk');
    expect(theirs).toBeTruthy();

    // A customer can never name another organization…
    await expect(risks.listRisks(otherAdmin, demoId)).rejects.toMatchObject({ status: 403 });
    // …nor read one of its risks by id: RLS hides the row, so it is simply not found.
    const demoRisk = (await risks.listRisks(analyst, demoId))[0];
    await expect(risks.getRisk(otherAdmin, demoRisk.id)).rejects.toMatchObject({ status: 404 });
    // Staff scoped to Demo Corp cannot reach the other organization either.
    await expect(risks.listRisks(analyst, otherId)).rejects.toMatchObject({ status: 403 });
    await expect(risks.getRisk(analyst, theirs.id)).rejects.toMatchObject({ status: 404 });

    // The portfolio summarizes each readable organization separately.
    const port = await risks.portfolio(analyst);
    expect(port.map((p) => p.organization_id)).toContain(demoId);
    expect(port.map((p) => p.organization_id)).not.toContain(otherId);
    const own = await risks.portfolio(otherAdmin);
    expect(own.map((p) => p.organization_id)).toEqual([otherId]);
  });

  it('refuses links to objects in another organization', async () => {
    const theirs = (await risks.listRisks(otherAdmin, undefined))[0];
    const demoTicket = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM tickets WHERE organization_id=$1 LIMIT 1', [demoId])).rows[0]);
    await expect(risks.addLink(otherAdmin, theirs.id, 'ticket', demoTicket.id)).rejects.toMatchObject({ status: 422 });
    // A platform control is shared, so linking one is fine.
    const control = await withSystemContext(async (sql) => (await sql.query('SELECT control_id FROM compliance_controls LIMIT 1')).rows[0]);
    const link = await risks.addLink(otherAdmin, theirs.id, 'control', control.control_id);
    expect(link.organization_id).toBe(otherId);
  });

  it('enforces separation of duties on acceptance, and time-boxes it', async () => {
    const r = await risks.createRisk(analyst, { organizationId: demoId, title: 'Integration: accept me', inherentLikelihood: 2, inherentImpact: 3 });
    await expect(
      risks.requestAcceptance(analyst, r.id, { justification: 'Low value asset, decommission planned', expiresAt: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString() }),
    ).rejects.toMatchObject({ status: 422 }); // beyond the org's maximum acceptance lifetime

    await risks.requestAcceptance(manager, r.id, { justification: 'Low value asset, decommission planned', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    // The analyst lacks risk.accept entirely; the manager requested it, so SoD bars them.
    await expect(risks.decideAcceptance(analyst, r.id, true)).rejects.toMatchObject({ status: 403 });
    await expect(risks.decideAcceptance(manager, r.id, true)).rejects.toMatchObject({ status: 403 });

    // Re-requested by the analyst, the manager may now decide.
    await withSystemContext((sql) => sql.query("UPDATE risks SET acceptance_status='none' WHERE id=$1", [r.id]));
    await risks.requestAcceptance(analyst, r.id, { justification: 'Low value asset, decommission planned', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    const decided = await risks.decideAcceptance(manager, r.id, true);
    expect(decided.status).toBe('accepted');
    expect(decided.acceptance_active).toBe(true);

    // Re-opening an accepted risk ends the acceptance.
    const reopened = await risks.transitionRisk(analyst, r.id, 'assessed');
    expect(reopened.acceptance_status).toBe('none');
    expect(reopened.acceptance_active).toBe(false);
  });

  it('runs a treatment plan and re-assesses', async () => {
    const r = await risks.createRisk(analyst, { organizationId: demoId, title: 'Integration: treat me', inherentLikelihood: 5, inherentImpact: 4, residualLikelihood: 5, residualImpact: 4 });
    const t = await risks.addTreatment(analyst, r.id, { title: 'Deploy EDR', dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await risks.getRisk(analyst, r.id)).status).toBe('treating');
    const done = await risks.updateTreatment(analyst, r.id, t.id, { status: 'done' });
    expect(done.completed_at).toBeTruthy();

    const after = await risks.updateRisk(analyst, r.id, { residualLikelihood: 2, note: 'EDR deployed fleet-wide' });
    expect(after.residual_score).toBe(8);
    const full = await risks.getRisk(analyst, r.id);
    expect(full.treatment_progress).toBe(100);
    expect(full.history.map((h: any) => h.kind)).toEqual(['created', 'reassessed']);
    await expect(risks.transitionRisk(analyst, r.id, 'identified')).rejects.toMatchObject({ status: 409 });
  });

  it('raises a risk from a posture finding once, linked back', async () => {
    const f = (await risks.findingCandidates(analyst, demoId))[0];
    expect(f).toBeTruthy();
    const r = await risks.createFromFinding(analyst, f.id);
    expect(r.title).toBe(f.title);
    const full = await risks.getRisk(analyst, r.id);
    expect(full.links).toEqual([expect.objectContaining({ kind: 'finding', ref: f.id })]);
    await expect(risks.createFromFinding(analyst, f.id)).rejects.toMatchObject({ status: 409 });
    expect((await risks.findingCandidates(analyst, demoId)).find((c: any) => c.id === f.id)).toBeUndefined();
  });

  it('exports CSV for one organization only, and gates appetite on risk.accept', async () => {
    const csv = await risks.exportCsv(analyst, demoId);
    expect(csv.split('\r\n')[0]).toContain('Residual score');
    expect(csv).not.toContain('Integration: other org risk');

    await expect(risks.putSettings(analyst, demoId, { appetiteScore: 8, toleranceScore: 12 })).rejects.toMatchObject({ status: 403 });
    const s = await risks.putSettings(otherAdmin, undefined, { appetiteScore: 4, toleranceScore: 8 });
    expect(s).toMatchObject({ organization_id: otherId, appetite_score: 4, is_default: false });
  });
});
