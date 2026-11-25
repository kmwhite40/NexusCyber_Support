// Risk acceptance packages against a live Postgres: issue, reprint, void, one package per risk,
// and organization separation.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { registerRiskRoutes } from '../../src/http/routes-risks.js';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import * as risks from '../../src/modules/risks.js';
import * as pkgs from '../../src/modules/acceptance-packages.js';
import * as attachments from '../../src/modules/attachments.js';
import { MAX_ATTACHMENT_BYTES } from '../../src/modules/storage.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const OWN_ORG = 'Package Suite Test Org';
const OWN_ADMIN = 'package-suite-admin@own.example';
const OWN_DECIDER = 'package-suite-decider@own.example';
// Staff SecurityAnalyst scoped to the private org: risk.read + risk.manage, deliberately no risk.accept.
const OWN_ANALYST = 'package-suite-analyst@nexus.example';
const OTHER_ORG = 'Package Isolation Test Org';
const OTHER_ADMIN = 'package-isolation-admin@other.example';
const future = () => new Date(Date.now() + 90 * 86_400_000).toISOString();

describeDb('risk acceptance packages (integration)', () => {
  let owner: Principal;   // OrgAdmin of this suite's private organization
  let manager: Principal;
  let decider: Principal; // second OrgAdmin of the private org: not the requester, so separation of duties allows it
  let analyst: Principal; // requester of the recorded risks; holds risk.read but not risk.accept
  let otherAdmin: Principal;
  let ownId: string;
  let otherId: string;

  /** A risk of `actor`'s register with an acceptance awaiting a decision. */
  async function requested(actor: Principal, orgId: string | undefined, title: string) {
    const r = await risks.createRisk(actor, { organizationId: orgId, title, inherentLikelihood: 4, inherentImpact: 4, residualLikelihood: 3, residualImpact: 4 });
    await risks.requestAcceptance(actor, r.id, { justification: `Business needs ${title}`, expiresAt: future() });
    return r;
  }

  async function cleanPackages() {
    await withSystemContext(async (sql) => {
      await sql.query('DELETE FROM risk_acceptance_packages WHERE organization_id = ANY($1::uuid[])', [[ownId, otherId]]);
    });
  }

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    // This suite runs on private organizations so it cannot disturb (or be disturbed by) suites that
    // share the dev database and run in parallel.
    const mkOrg = (name: string, email: string) => withSystemContext(async (sql) => {
      const existing = (await sql.query('SELECT id FROM organizations WHERE name=$1', [name])).rows[0];
      const id = existing?.id ?? (await sql.query(
        `INSERT INTO organizations (name, cloud, enclave_id, status) VALUES ($1,'commercial','commercial','active') RETURNING id`, [name],
      )).rows[0].id;
      const u = (await sql.query(
        `INSERT INTO users (plane, organization_id, email, display_name) VALUES ('customer',$1,$2,'Suite Admin')
         ON CONFLICT (plane, email) DO UPDATE SET organization_id=EXCLUDED.organization_id RETURNING id`, [id, email],
      )).rows[0].id;
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id) SELECT $1, r.id, $2 FROM roles r WHERE r.key='OrgAdmin' ON CONFLICT DO NOTHING`,
        [u, id],
      );
      return id as string;
    });
    ownId = await mkOrg(OWN_ORG, OWN_ADMIN);
    await mkOrg(OWN_ORG, OWN_DECIDER);
    otherId = await mkOrg(OTHER_ORG, OTHER_ADMIN);
    await withSystemContext(async (sql) => {
      const u = (await sql.query(
        `INSERT INTO users (plane, email, display_name) VALUES ('nexus',$1,'Suite Analyst')
         ON CONFLICT (plane, email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`, [OWN_ANALYST],
      )).rows[0].id;
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id)
         SELECT $1, r.id, $2 FROM roles r WHERE r.key='SecurityAnalyst'
          AND NOT EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.user_id=$1 AND ra.role_id=r.id AND ra.organization_id=$2)`,
        [u, ownId],
      );
    });
    analyst = await principalByEmail(OWN_ANALYST);
    owner = await principalByEmail(OWN_ADMIN);
    decider = await principalByEmail(OWN_DECIDER);
    otherAdmin = await principalByEmail(OTHER_ADMIN);
    await cleanPackages();
  });

  afterAll(async () => {
    // Deleting the organizations cascades to their risks, packages and signed copies — first, because
    // a signed copy's uploaded_by would otherwise keep its uploader from being deleted.
    await withSystemContext(async (sql) => {
      await sql.query('DELETE FROM organizations WHERE name = ANY($1::text[])', [[OWN_ORG, OTHER_ORG]]);
      await sql.query('DELETE FROM users WHERE email = ANY($1::text[])', [[OWN_ADMIN, OWN_DECIDER, OTHER_ADMIN, OWN_ANALYST]]);
    });
  });

  it('issues a package of the org\'s requested risks', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: issue A');
    const b = await requested(owner, ownId, 'Pkg: issue B');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, reference: 'RA-TEST' });
    expect(s.number).toBe('AP-0001');
    expect(s.status).toBe('issued');
    expect([...s.risk_ids].sort()).toEqual([a.id, b.id].sort());
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s).not.toHaveProperty('html');
    const { html, packageNumber } = await pkgs.getPackageHtml(owner, s.id);
    expect(packageNumber).toBe('AP-0001');
    expect(html).toContain(a.ref);
    expect(html).toContain(b.ref);
    expect(html).toContain('RA-TEST');
    expect(html).toContain(s.sha256.slice(0, 12));
    expect((await pkgs.listPackages(owner, ownId)).map((p) => p.id)).toContain(s.id);
  });

  it('reprint is identical after the risk changes', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: reprint');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId });
    const first = (await pkgs.getPackageHtml(owner, s.id)).html;
    await risks.updateRisk(owner, a.id, { title: 'Pkg: reprint CHANGED', residualLikelihood: 1 });
    const second = (await pkgs.getPackageHtml(owner, s.id)).html;
    expect(second).toBe(first);
    expect(second).not.toContain('CHANGED');
  });

  it('refuses risks of another organization', async () => {
    await cleanPackages();
    const mine = await requested(owner, ownId, 'Pkg: mine');
    const theirs = await requested(otherAdmin, undefined, 'Pkg: theirs');
    await expect(pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [mine.id, theirs.id] })).rejects.toMatchObject({ status: 400 });
    await pkgs.issuePackage(owner, { organizationId: ownId });
    const all = await withSystemContext(async (sql) =>
      (await sql.query('SELECT html FROM risk_acceptance_packages WHERE organization_id=$1', [ownId])).rows,
    );
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.html).not.toContain(OTHER_ORG);
      expect(row.html).not.toContain('Pkg: theirs');
    }
  });

  it('refuses risks not awaiting acceptance', async () => {
    await cleanPackages();
    const t = await risks.createRisk(owner, { organizationId: ownId, title: 'Pkg: treating', inherentLikelihood: 3, inherentImpact: 3, residualLikelihood: 3, residualImpact: 3 });
    await risks.transitionRisk(owner, t.id, 'treating');
    await requested(owner, ownId, 'Pkg: awaiting');
    await expect(pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [t.id] })).rejects.toMatchObject({ status: 400 });
  });

  it('a risk is in at most one issued package', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: once');
    const first = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    await expect(pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] })).rejects.toMatchObject({ status: 409 });
    await expect(pkgs.issuePackage(owner, { organizationId: ownId })).rejects.toMatchObject({ status: 409 });
    const voided = await pkgs.voidPackage(owner, first.id, 'Issued in error');
    expect(voided.status).toBe('void');
    await expect(pkgs.voidPackage(owner, first.id, 'Again')).rejects.toMatchObject({ status: 409 });
    const second = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    expect(second.number).toBe('AP-0002');
  });

  it('concurrent issue gives the risk to one package', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: race');
    const results = await Promise.allSettled([
      pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] }),
      pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] }),
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
    await requested(owner, ownId, 'Pkg: private');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId });
    await expect(pkgs.listPackages(otherAdmin, ownId)).rejects.toMatchObject({ status: 403 });
    await expect(pkgs.getPackageHtml(otherAdmin, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(pkgs.voidPackage(otherAdmin, s.id, 'sneaky')).rejects.toMatchObject({ status: 404 });
    expect(await pkgs.listPackages(otherAdmin)).toEqual([]);
  });

  it('audits issue, export and void', async () => {
    await cleanPackages();
    await requested(owner, ownId, 'Pkg: audit');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId });
    await pkgs.getPackageHtml(owner, s.id);
    await pkgs.voidPackage(owner, s.id, 'Audit check');
    const actions = await withSystemContext(async (sql) =>
      (await sql.query('SELECT action FROM audit_logs WHERE resource_id=$1', [s.id])).rows.map((r: any) => r.action),
    );
    expect(actions).toEqual(expect.arrayContaining([
      'risk.acceptance_package.issue', 'risk.acceptance_package.export', 'risk.acceptance_package.void',
    ]));
  });

  it('direct decide is refused while in an issued package', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: blocked');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    await expect(risks.decideAcceptance(decider, a.id, true)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(s.number) });
    await expect(risks.decideAcceptance(decider, a.id, false)).rejects.toMatchObject({ status: 409 });
    expect((await risks.getRisk(owner, a.id)).acceptance_status).toBe('requested');
  });

  it('direct decide works again after void', async () => {
    await cleanPackages();
    const a = await requested(owner, ownId, 'Pkg: unblocked');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    await pkgs.voidPackage(owner, s.id, 'Issued in error');
    const decided = await risks.decideAcceptance(decider, a.id, true);
    expect(decided.status).toBe('accepted');
  });
  // ---------------- Recording the signed package ----------------

  const signedCopy = (bytes: Buffer = Buffer.from('%PDF-1.4 signed acceptance package')) =>
    ({ filename: 'signed.pdf', contentType: 'application/pdf', bytes });
  const record = (actor: Principal, id: string, decisions: Record<string, pkgs.PackageDecision>, over: Partial<Parameters<typeof pkgs.recordSignature>[2]> = {}) =>
    pkgs.recordSignature(actor, id, {
      signedByName: 'Jane Doe', signedByTitle: 'Authorizing Official', signedOn: '2026-12-01', decisions, file: signedCopy(), ...over,
    });
  async function sysQuery(text: string, params: unknown[]) {
    return withSystemContext(async (sql) => (await sql.query(text, params)).rows);
  }
  /** What a refused record must leave untouched: the package, its risks and the attachments table. */
  async function stateOf(packageId: string, riskIds: string[]) {
    return {
      pkg: (await sysQuery('SELECT status, signed_attachment_id, recorded_at, decisions FROM risk_acceptance_packages WHERE id=$1', [packageId]))[0],
      risks: await sysQuery('SELECT id, status, acceptance_status, acceptance_decided_by FROM risks WHERE id = ANY($1::uuid[]) ORDER BY id', [riskIds]),
      attachments: await sysQuery('SELECT id FROM attachments WHERE acceptance_package_id=$1', [packageId]),
    };
  }
  async function expectUnchanged(packageId: string, riskIds: string[], before: Awaited<ReturnType<typeof stateOf>>) {
    expect(before.pkg).toMatchObject({ status: 'issued', signed_attachment_id: null });
    expect(await stateOf(packageId, riskIds)).toEqual(before);
  }

  it('records accepted, not accepted and not marked', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: accepted');
    const b = await requested(analyst, ownId, 'Rec: not accepted');
    const c = await requested(analyst, ownId, 'Rec: not marked');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id, b.id, c.id] });
    const out = await record(decider, s.id, { [a.id]: 'accepted', [b.id]: 'not_accepted', [c.id]: 'not_marked' });
    expect(out).toMatchObject({ id: s.id, status: 'signed', signed_by_name: 'Jane Doe', signed_by_title: 'Authorizing Official', signed_on: '2026-12-01' });
    expect(out.signed_attachment_id).toBeTruthy();
    expect(out.recorded_at).toBeTruthy();
    expect(out.decisions).toEqual({ [a.id]: 'accepted', [b.id]: 'not_accepted', [c.id]: 'not_marked' });
    const [att] = await sysQuery('SELECT acceptance_package_id, ticket_id, scan_status, uploaded_by FROM attachments WHERE id=$1', [out.signed_attachment_id]);
    expect(att).toMatchObject({ acceptance_package_id: s.id, ticket_id: null, scan_status: 'clean', uploaded_by: decider.id });

    const ra = await risks.getRisk(owner, a.id);
    expect(ra.status).toBe('accepted');
    expect(ra.acceptance_status).toBe('approved');
    expect(ra.acceptance_decided_by).toBe(decider.id);
    expect((await risks.getRisk(owner, b.id)).acceptance_status).toBe('rejected');
    expect((await risks.getRisk(owner, c.id)).acceptance_status).toBe('requested');

    const note = `Signed by Jane Doe, Authorizing Official on 2026-12-01; package ${s.number} (${s.sha256.slice(0, 12)})`;
    for (const [id, kind] of [[a.id, 'accepted'], [b.id, 'acceptance_rejected']]) {
      const [h] = await sysQuery('SELECT kind, note FROM risk_history WHERE risk_id=$1 ORDER BY created_at DESC LIMIT 1', [id]);
      expect(h).toEqual({ kind, note });
    }
    // Not marked: still awaiting a decision, and free for a new package.
    const again = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [c.id] });
    expect(again.status).toBe('issued');

    const actions = (await sysQuery('SELECT action FROM audit_logs WHERE resource_id=$1', [s.id])).map((r: any) => r.action);
    expect(actions).toContain('risk.acceptance_package.record');
  });

  it('requires a decision for every risk', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: every A');
    const b = await requested(analyst, ownId, 'Rec: every B');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id, b.id] });
    const before = await stateOf(s.id, [a.id, b.id]);
    await expect(record(decider, s.id, { [a.id]: 'accepted' })).rejects.toMatchObject({ status: 400 });
    await expect(record(decider, s.id, { [a.id]: 'accepted', [b.id]: 'accepted', [randomUUID()]: 'accepted' })).rejects.toMatchObject({ status: 400 });
    await expect(record(decider, s.id, { [a.id]: 'accepted', [b.id]: 'maybe' as any })).rejects.toMatchObject({ status: 400 });
    // An impossible calendar date is refused up front, not after the decisions are applied.
    for (const signedOn of ['2026-02-30', '2026-13-01', '2026-12-1'])
      await expect(record(decider, s.id, { [a.id]: 'accepted', [b.id]: 'accepted' }, { signedOn }), signedOn).rejects.toMatchObject({ status: 400 });
    await expectUnchanged(s.id, [a.id, b.id], before);
  });

  it('refuses when a risk changed after issue', async () => {
    const cases: Array<[string, (id: string) => Promise<unknown>]> = [
      ['residual reassessed', (id) => risks.updateRisk(owner, id, { residualLikelihood: 1 })],
      ['justification re-requested', (id) => sysQuery(`UPDATE risks SET acceptance_justification='A different case' WHERE id=$1`, [id])],
      ['expiry changed', (id) => sysQuery(`UPDATE risks SET acceptance_expires_at=acceptance_expires_at + interval '1 day' WHERE id=$1`, [id])],
      ['risk closed', (id) => risks.transitionRisk(owner, id, 'closed')],
    ];
    for (const [label, change] of cases) {
      await cleanPackages();
      const keep = await requested(analyst, ownId, `Rec: unchanged beside ${label}`);
      const r = await requested(analyst, ownId, `Rec: ${label}`);
      const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [keep.id, r.id] });
      await change(r.id);
      const before = await stateOf(s.id, [keep.id, r.id]);
      await expect(record(decider, s.id, { [keep.id]: 'accepted', [r.id]: 'accepted' }), label)
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining(r.ref) });
      await expectUnchanged(s.id, [keep.id, r.id], before);
    }
  });

  it('refuses an expired or late-signed acceptance', async () => {
    await cleanPackages();
    const expired = await requested(analyst, ownId, 'Rec: expired');
    await sysQuery(`UPDATE risks SET acceptance_expires_at=now() - interval '1 day' WHERE id=$1`, [expired.id]);
    const s1 = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [expired.id] });
    const before1 = await stateOf(s1.id, [expired.id]);
    await expect(record(decider, s1.id, { [expired.id]: 'accepted' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(expired.ref) });
    await expectUnchanged(s1.id, [expired.id], before1);

    const late = await requested(analyst, ownId, 'Rec: late');
    const s2 = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [late.id] });
    const before2 = await stateOf(s2.id, [late.id]);
    const [{ d }] = await sysQuery(`SELECT to_char((acceptance_expires_at AT TIME ZONE 'UTC') + interval '1 day', 'YYYY-MM-DD') AS d FROM risks WHERE id=$1`, [late.id]);
    await expect(record(decider, s2.id, { [late.id]: 'accepted' }, { signedOn: d })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(late.ref) });
    await expectUnchanged(s2.id, [late.id], before2);
  });

  it('separation of duties', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: sod analyst');
    const own = await requested(decider, ownId, 'Rec: sod decider');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id, own.id] });
    const before = await stateOf(s.id, [a.id, own.id]);
    await expect(record(analyst, s.id, { [a.id]: 'accepted', [own.id]: 'accepted' })).rejects.toMatchObject({ status: 403 });
    await expect(record(decider, s.id, { [a.id]: 'accepted', [own.id]: 'accepted' }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('separation of duties') });
    await expectUnchanged(s.id, [a.id, own.id], before);
  });

  it('rejects an invalid signed copy without recording', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: bad copy');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    const before = await stateOf(s.id, [a.id]);
    const d = { [a.id]: 'accepted' as const };
    await expect(record(decider, s.id, d, { file: { filename: 'x.exe', contentType: 'application/x-msdownload', bytes: Buffer.from('MZ') } }))
      .rejects.toMatchObject({ status: 422 });
    await expect(record(decider, s.id, d, { file: signedCopy(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)) })).rejects.toMatchObject({ status: 422 });
    await expect(record(decider, s.id, d, { file: undefined as any })).rejects.toMatchObject({ status: 400 });
    await expect(record(decider, s.id, d, { file: signedCopy(Buffer.from('X5O EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) }))
      .rejects.toMatchObject({ status: 409 });
    await expectUnchanged(s.id, [a.id], before);
    // The refused copy's blob is deleted too, not just its row.
    const dir = join(process.env.BLOB_DIR ?? join(tmpdir(), 'nexus-blobs'), ownId, 'acceptance-packages', s.id);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('refuses a package that is not issued', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: twice');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    await record(decider, s.id, { [a.id]: 'not_accepted' });
    await expect(record(decider, s.id, { [a.id]: 'not_accepted' })).rejects.toMatchObject({ status: 409 });
    const b = await requested(analyst, ownId, 'Rec: voided');
    const v = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [b.id] });
    await pkgs.voidPackage(owner, v.id, 'Issued in error');
    await expect(record(decider, v.id, { [b.id]: 'accepted' })).rejects.toMatchObject({ status: 409 });
    expect((await risks.getRisk(owner, b.id)).acceptance_status).toBe('requested');
  });

  it('a direct decision racing an issue or a record lands once', async () => {
    for (let i = 0; i < 3; i++) {
      await cleanPackages();
      const a = await requested(analyst, ownId, `Race: issue vs decide ${i}`);
      const [issued, decided] = await Promise.allSettled([
        pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] }),
        risks.decideAcceptance(decider, a.id, true),
      ]);
      // Exactly one wins: a package of a risk that is still awaiting, or a decision outside any package.
      expect([issued.status, decided.status].filter((x) => x === 'fulfilled'), `round ${i}`).toHaveLength(1);
      const [row] = await sysQuery('SELECT acceptance_status FROM risks WHERE id=$1', [a.id]);
      expect(row.acceptance_status).toBe(issued.status === 'fulfilled' ? 'requested' : 'approved');
    }
    await cleanPackages();
    const b = await requested(analyst, ownId, 'Race: record vs decide');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [b.id] });
    const [rec, dec] = await Promise.allSettled([record(decider, s.id, { [b.id]: 'not_accepted' }), risks.decideAcceptance(decider, b.id, true)]);
    expect(rec.status).toBe('fulfilled');
    expect(dec).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const decisions = await sysQuery(`SELECT kind FROM risk_history WHERE risk_id=$1 AND kind IN ('accepted','acceptance_rejected')`, [b.id]);
    expect(decisions.map((h: any) => h.kind)).toEqual(['acceptance_rejected']);
  });

  it('signed copy downloads with risk.read', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: download');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    const bytes = Buffer.from('%PDF-1.4 the signed one');
    const out = await record(decider, s.id, { [a.id]: 'accepted' }, { file: signedCopy(bytes) });
    // The analyst has risk.read but not ticket.comment: only the package branch can authorize this.
    const got = await attachments.download(analyst, out.signed_attachment_id!);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.contentType).toBe('application/pdf');
    await expect(attachments.download(otherAdmin, out.signed_attachment_id!)).rejects.toMatchObject({ status: 404 });
  });
  it('getRisk lists its packages', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: detail A');
    const b = await requested(analyst, ownId, 'Rec: detail B');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id, b.id] });
    let detail = await risks.getRisk(analyst, a.id);
    expect(detail.acceptance_packages).toHaveLength(1);
    expect(detail.acceptance_packages[0]).toMatchObject({ id: s.id, number: s.number, status: 'issued', signed_by_name: null, signed_by_title: null, signed_on: null, signed_attachment_id: null });

    const out = await record(decider, s.id, { [a.id]: 'accepted', [b.id]: 'not_marked' });
    detail = await risks.getRisk(analyst, a.id);
    expect(detail.acceptance_packages[0]).toMatchObject({
      number: s.number, status: 'signed', signed_by_name: 'Jane Doe', signed_by_title: 'Authorizing Official',
      signed_on: '2026-12-01', signed_attachment_id: out.signed_attachment_id,
    });
    // Not marked: the package stays in its history, and a new one is listed newest first.
    const again = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [b.id] });
    const listed = (await risks.getRisk(analyst, b.id)).acceptance_packages;
    expect(listed.map((p: any) => p.number)).toEqual([again.number, s.number]);
    expect(listed.map((p: any) => p.status)).toEqual(['issued', 'signed']);
  });
  it('records through the multipart route', async () => {
    await cleanPackages();
    const a = await requested(analyst, ownId, 'Rec: route');
    const s = await pkgs.issuePackage(owner, { organizationId: ownId, riskIds: [a.id] });
    const app = Fastify();
    await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
    app.addHook('onRequest', async (req) => { (req as any).principal = decider; });
    app.setErrorHandler((err: any, _req, reply) => { reply.status(err.status ?? err.statusCode ?? (err.issues ? 422 : 500)).send({ detail: err.detail ?? err.message }); });
    await registerRiskRoutes(app);
    const post = (parts: Array<{ name: string; value: string; filename?: string; type?: string }>) => {
      const boundary = 'x-boundary-1';
      const body = parts.map((p) => `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"\r\nContent-Type: ${p.type}` : ''}\r\n\r\n${p.value}\r\n`).join('') + `--${boundary}--\r\n`;
      return app.inject({ method: 'POST', url: `/api/v1/risks/acceptance-packages/${s.id}/record`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    };
    const payload = JSON.stringify({ signedByName: 'Jane Doe', signedByTitle: 'Authorizing Official', signedOn: '2026-12-01', decisions: { [a.id]: 'accepted' } });
    try {
      expect((await post([{ name: 'payload', value: payload }])).statusCode).toBe(400);
      const res = await post([{ name: 'payload', value: payload }, { name: 'file', value: '%PDF-1.4 via route', filename: 'signed.pdf', type: 'application/pdf' }]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: 'signed', signed_by_name: 'Jane Doe' });
    } finally {
      await app.close();
    }
  }, 60_000); // first Fastify boot is slow on a network-shared node_modules
});
