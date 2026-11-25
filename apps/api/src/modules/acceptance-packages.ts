// Risk acceptance packages — issue, list, reprint, void.
//
// A package freezes one organization's risks awaiting acceptance into a print-ready page. The
// snapshot is built from that organization's rows only (RLS plus an explicit organization_id on
// every query), hashed as built, rendered once and stored; a reprint returns the stored html
// byte for byte and never re-reads the live risks.
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import { resolveUserNames } from './user-names.js';
import { resolveOrg, loadSettings, issuedPackageFor } from './risks.js';
import { rating, riskRef } from './risk-scoring.js';
import {
  packageNumber, renderPackageHtml, snapshotSha256,
  type PackageRiskSnapshot, type PackageScore, type PackageSnapshot,
} from './acceptance-package-render.js';
import type { Principal } from '../types.js';

export interface PackageSummary {
  id: string;
  organization_id: string;
  number: string;
  reference: string | null;
  status: string;
  risk_ids: string[];
  sha256: string;
  generated_at: string;
  generated_by: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  signed_on: string | null;
  recorded_at: string | null;
  signed_attachment_id: string | null;
  decisions: unknown;
}

// Everything except html and snapshot, which are large and fetched only by the print route.
const SUMMARY_COLS = `id, organization_id, package_number, reference, status, risk_ids, sha256, generated_at, generated_by,
  signed_by_name, signed_by_title, to_char(signed_on, 'YYYY-MM-DD') AS signed_on, recorded_at, signed_attachment_id, decisions`;

function summarize(r: any): PackageSummary {
  const { package_number, ...rest } = r;
  return { ...rest, number: packageNumber(package_number) };
}

const score = (l: number, i: number, s: number, methodology: string): PackageScore => ({ l, i, score: s, rating: rating(s, methodology) });

async function buildRisks(sql: Sql, org: string, rows: any[]): Promise<PackageRiskSnapshot[]> {
  const ids = rows.map((r) => r.id);
  const treatments = (await sql.query(
    `SELECT risk_id, title, status, due_at FROM risk_treatments
      WHERE organization_id=$1 AND risk_id = ANY($2::uuid[]) AND status <> 'cancelled' ORDER BY coalesce(due_at, created_at), created_at`,
    [org, ids],
  )).rows;
  const links = (await sql.query(
    `SELECT risk_id, ref, label FROM risk_links WHERE organization_id=$1 AND risk_id = ANY($2::uuid[]) AND kind='control' ORDER BY created_at`,
    [org, ids],
  )).rows;
  const requested = (await sql.query(
    `SELECT DISTINCT ON (risk_id) risk_id, created_at FROM risk_history
      WHERE organization_id=$1 AND risk_id = ANY($2::uuid[]) AND kind='acceptance_requested' ORDER BY risk_id, created_at DESC`,
    [org, ids],
  )).rows;
  const names = await resolveUserNames(rows.flatMap((r) => [r.owner_id, r.acceptance_requested_by]));
  return rows.map((r): PackageRiskSnapshot => ({
    id: r.id,
    ref: riskRef(r.risk_number),
    title: r.title,
    cause: r.cause,
    event: r.event,
    consequence: r.consequence,
    category: r.category,
    ownerName: (r.owner_id && names.get(r.owner_id)) || r.owner_name || null,
    threatSource: r.threat_source,
    velocity: r.velocity,
    inherent: score(r.inherent_likelihood, r.inherent_impact, r.inherent_score, r.methodology),
    residual: score(r.residual_likelihood, r.residual_impact, r.residual_score, r.methodology),
    target: r.target_score ? score(r.target_likelihood, r.target_impact, r.target_score, r.methodology) : null,
    impactDimensions: r.impact_dimensions ?? {},
    description: r.description,
    controls: links.filter((l: any) => l.risk_id === r.id).map((l: any) => ({
      id: l.ref,
      title: String(l.label ?? '').startsWith(`${l.ref} · `) ? l.label.slice(l.ref.length + 3) : (l.label ?? ''),
    })),
    treatments: treatments.filter((t: any) => t.risk_id === r.id).map((t: any) => ({
      title: t.title, status: t.status, dueAt: t.due_at ? new Date(t.due_at).toISOString() : null,
    })),
    justification: r.acceptance_justification ?? '',
    expiresAt: new Date(r.acceptance_expires_at).toISOString(),
    requestedBy: (r.acceptance_requested_by && names.get(r.acceptance_requested_by)) || null,
    requestedAt: (() => {
      const h = requested.find((x: any) => x.risk_id === r.id);
      return h ? new Date(h.created_at).toISOString() : null;
    })(),
  }));
}

export async function issuePackage(
  actor: Principal,
  input: { organizationId?: string; riskIds?: string[]; reference?: string | null },
): Promise<PackageSummary> {
  const org = resolveOrg(actor, input.organizationId);
  authorize(actor, 'risk.manage', { organizationId: org });
  const wanted = input.riskIds ? [...new Set(input.riskIds)] : null;

  const summary = await withOrgContext(orgContextFor(actor), async (sql) => {
    // Serialize per organization: concurrent issues must neither share a number nor a risk.
    await sql.query(`SELECT pg_advisory_xact_lock(hashtext('acceptance_package:' || $1))`, [org]);
    const { rows } = await sql.query(
      `SELECT * FROM risks WHERE organization_id=$1 AND acceptance_status='requested'
          AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY risk_number`,
      [org, wanted],
    );
    if (wanted) {
      const missing = wanted.filter((id) => !rows.some((r: any) => r.id === id));
      if (missing.length) throw Errors.badRequest(`not awaiting acceptance in this organization: ${missing.join(', ')}`);
    }
    if (rows.length === 0) throw Errors.badRequest('no risks are awaiting acceptance');
    for (const r of rows) {
      const held = await issuedPackageFor(sql, r.id);
      if (held) throw Errors.conflict(`${riskRef(r.risk_number)} is already in issued package ${held.packageNumber}`);
    }

    const n = (await sql.query('SELECT coalesce(max(package_number),0)+1 AS n FROM risk_acceptance_packages WHERE organization_id=$1', [org])).rows[0].n;
    const orgName = (await sql.query('SELECT name FROM organizations WHERE id=$1', [org])).rows[0]?.name;
    if (!orgName) throw Errors.notFound('organization not found');
    const settings = await loadSettings(sql, org);
    const snapshot: PackageSnapshot = {
      organization: { id: org, name: orgName },
      packageNumber: packageNumber(n),
      reference: input.reference ?? null,
      generatedAt: new Date().toISOString(),
      generatedBy: actor.displayName ?? actor.email ?? actor.id,
      appetite: settings.appetite_score,
      tolerance: settings.tolerance_score,
      risks: await buildRisks(sql, org, rows),
    };
    const hash = snapshotSha256(snapshot);
    const html = renderPackageHtml(snapshot, hash);
    const ins = await sql.query(
      `INSERT INTO risk_acceptance_packages (organization_id, package_number, reference, risk_ids, snapshot, html, sha256, status, generated_by, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9) RETURNING ${SUMMARY_COLS}`,
      [org, n, snapshot.reference, rows.map((r: any) => r.id), JSON.stringify(snapshot), html, hash, actor.id, snapshot.generatedAt],
    );
    return summarize(ins.rows[0]);
  });

  await audit(actor, {
    action: 'risk.acceptance_package.issue', organizationId: org, resourceType: 'acceptance_package', resourceId: summary.id,
    detail: { number: summary.number, riskCount: summary.risk_ids.length, sha256: summary.sha256 },
  });
  return summary;
}

export async function listPackages(actor: Principal, organizationId?: string): Promise<PackageSummary[]> {
  const org = resolveOrg(actor, organizationId);
  authorize(actor, 'risk.read', { organizationId: org });
  return withOrgContext(orgContextFor(actor), async (sql) =>
    (await sql.query(
      `SELECT ${SUMMARY_COLS} FROM risk_acceptance_packages WHERE organization_id=$1 ORDER BY package_number DESC`, [org],
    )).rows.map(summarize),
  );
}

export async function getPackageHtml(actor: Principal, id: string): Promise<{ html: string; packageNumber: string }> {
  const row = await withOrgContext(orgContextFor(actor), async (sql) =>
    (await sql.query('SELECT organization_id, package_number, html, sha256 FROM risk_acceptance_packages WHERE id=$1', [id])).rows[0],
  );
  if (!row) throw Errors.notFound('acceptance package not found');
  authorize(actor, 'risk.read', { organizationId: row.organization_id });
  await audit(actor, {
    action: 'risk.acceptance_package.export', organizationId: row.organization_id, resourceType: 'acceptance_package', resourceId: id,
    detail: { number: packageNumber(row.package_number), sha256: row.sha256 },
  });
  return { html: row.html, packageNumber: packageNumber(row.package_number) };
}

export async function voidPackage(actor: Principal, id: string, reason: string): Promise<PackageSummary> {
  const summary = await withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT organization_id, status FROM risk_acceptance_packages WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw Errors.notFound('acceptance package not found');
    authorize(actor, 'risk.manage', { organizationId: cur.organization_id });
    if (cur.status !== 'issued') throw Errors.conflict(`only an issued package can be voided (this one is ${cur.status})`);
    const { rows } = await sql.query(
      `UPDATE risk_acceptance_packages SET status='void', void_reason=$2 WHERE id=$1 RETURNING ${SUMMARY_COLS}`, [id, reason],
    );
    return summarize(rows[0]);
  });
  await audit(actor, {
    action: 'risk.acceptance_package.void', organizationId: summary.organization_id, resourceType: 'acceptance_package', resourceId: id,
    detail: { number: summary.number, reason },
  });
  return summary;
}
