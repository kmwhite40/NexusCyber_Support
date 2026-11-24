// Import of the GDAP configuration risk register (SBS-GRC-RR-GDAP) into the live risk register.
// Each row is filed in the organization whose entra_tenant_id matches the tenant id stated in the
// row ("Tenant: SBS Federal (sbsfederal.com, d0529da6-...)"): Nexus Cyber, SBS Federal, Quantifind
// and Fabric each get their own entries. DRY RUN unless --apply is passed.
//
// Refuses to write anything when any row's tenant maps to no organization: a GDAP risk must never
// land in the wrong tenant's register, and a partial import would hide the missing one.
// Idempotent: external_ref is the register id (GDAP-SBS-01), unique per organization (0086).
// Attribution: the audit actor is the system (null), the honest actor for a script.
//
// Usage (from apps/api):
//   npx tsx src/scripts/import-gdap-risks.ts --file ~/Downloads/SBS_GCCH_GDAP_Risk_Register.csv   # dry run
//   ... --apply
import { readFileSync } from 'node:fs';
import { withSystemContext } from '../db/pool.js';
import { audit } from '../modules/audit.js';
import { nextReviewAt } from '../modules/risk-scoring.js';
import { GDAP_SOURCE, gdapRisks, type GdapRisk } from '../modules/gdap-risk-import.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const fileArg = argv[argv.indexOf('--file') + 1];
if (!argv.includes('--file') || !fileArg) { console.error('pass --file <csv>'); process.exit(1); }

const risks = gdapRisks(readFileSync(fileArg, 'utf8'));
const created: Array<{ org: string; id: string; ref: string }> = [];

await withSystemContext(async (sql) => {
  console.log(`mode   : ${APPLY ? 'APPLY' : 'dry run (pass --apply to write)'}`);
  console.log(`rows   : ${risks.length}`);

  const tenantIds = [...new Set(risks.map((r) => r.tenantId))];
  const orgs = new Map<string, { id: string; name: string }>(
    (await sql.query('SELECT id, name, entra_tenant_id::text AS tid FROM organizations WHERE entra_tenant_id = ANY($1::uuid[])', [tenantIds]))
      .rows.map((o: any) => [o.tid, { id: o.id, name: o.name }]),
  );
  const missing = tenantIds.filter((t) => !orgs.has(t));
  for (const t of tenantIds) {
    const o = orgs.get(t);
    const n = risks.filter((r) => r.tenantId === t).length;
    const name = risks.find((r) => r.tenantId === t)!.tenantName;
    console.log(`tenant : ${name.padEnd(28)} ${t} -> ${o ? `${o.name} (${o.id})` : 'NO ORGANIZATION'}  ${n} risks`);
  }
  if (missing.length) {
    throw new Error(`no organization has entra_tenant_id ${missing.join(', ')}; set it (Admin > Organizations) and re-run. Nothing was written.`);
  }

  const catalog = (await sql.query('SELECT control_id, framework FROM compliance_controls')).rows as Array<{ control_id: string; framework: string }>;
  const known = new Set(catalog.map((c) => c.control_id));
  // A CMMC practice is identified by its 800-171 requirement; the level in the id is derived. A
  // citation with the wrong level ("IA.L2-3.5.1" for Level 1 IA.L1-3.5.1) resolves by requirement.
  const cmmcByReq = new Map(catalog.filter((c) => c.framework === 'CMMC-L2').map((c) => [c.control_id.replace(/^.*-/, ''), c.control_id]));
  for (const r of risks) {
    r.controls = r.controls.map((c) => {
      const m = c.match(/^[A-Z]{2}\.L[123]-(3\.\d+\.\d+)$/);
      const fixed = m && !known.has(c) ? cmmcByReq.get(m[1]) : undefined;
      if (fixed) console.log(`control: ${r.registerId} cites ${c}; filed as ${fixed}`);
      return fixed ?? c;
    });
  }
  const seen = new Set((await sql.query('SELECT organization_id, external_ref FROM risks WHERE external_source=$1', [GDAP_SOURCE]))
    .rows.map((r: any) => `${r.organization_id}:${r.external_ref}`));
  const todo = risks.filter((r) => !seen.has(`${orgs.get(r.tenantId)!.id}:${r.registerId}`));

  console.log('');
  for (const r of risks) {
    const skip = !todo.includes(r);
    const unknown = r.controls.filter((c) => !known.has(c));
    console.log(`  ${skip ? 'skip' : 'new '} ${r.registerId.padEnd(13)} ${orgs.get(r.tenantId)!.name.padEnd(16)} `
      + `inh ${r.inherent.likelihood * r.inherent.impact} res ${r.residual.likelihood * r.residual.impact} tgt ${r.target.likelihood * r.target.impact} `
      + `${r.strategy.padEnd(8)} ${r.treatments.length} treatments, ${r.controls.length - unknown.length}/${r.controls.length} controls`
      + `${unknown.length ? `  (not in catalog: ${unknown.join(', ')})` : ''}`);
  }
  console.log(`\n${todo.length} to create, ${risks.length - todo.length} already imported`);
  if (!APPLY || !todo.length) return;

  await sql.query('BEGIN');
  try {
    for (const r of todo) created.push(await insert(sql, orgs.get(r.tenantId)!.id, r, known));
    await sql.query('COMMIT');
  } catch (err) {
    await sql.query('ROLLBACK');
    throw err;
  }
});

async function insert(sql: any, org: string, r: GdapRisk, known: Set<string>) {
  // Same per-organization numbering lock as createRisk.
  await sql.query(`SELECT pg_advisory_xact_lock(hashtext('risk_number:' || $1))`, [org]);
  const n = (await sql.query('SELECT coalesce(max(risk_number),0)+1 AS n FROM risks WHERE organization_id=$1', [org])).rows[0].n;
  const now = new Date();
  // Every row carries a treatment plan, so it is being treated (as addTreatment would set it).
  // 'accept' rows stay 'treating': their plan includes the Authorizing Official acceptance, which
  // goes through the register's acceptance workflow rather than being asserted by an import.
  const status = r.treatments.length ? 'treating' : 'assessed';
  const { rows } = await sql.query(
    `INSERT INTO risks (organization_id, risk_number, title, description, cause, event, consequence, category,
        threat_source, status, strategy, owner_name,
        inherent_likelihood, inherent_impact, residual_likelihood, residual_impact, target_likelihood, target_impact,
        impact_dimensions, velocity, review_frequency_days, last_reviewed_at, next_review_at, tags,
        external_ref, external_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING id, inherent_score, residual_score, target_score, methodology`,
    [org, n, r.title, r.description, r.cause, r.event, r.consequence, r.category, r.threatSource, status, r.strategy, r.ownerName,
      r.inherent.likelihood, r.inherent.impact, r.residual.likelihood, r.residual.impact, r.target.likelihood, r.target.impact,
      JSON.stringify(r.impactDimensions), r.velocity, r.reviewFrequencyDays, now,
      nextReviewAt(r.residual.likelihood * r.residual.impact, now, r.reviewFrequencyDays), r.tags, r.registerId, GDAP_SOURCE],
  );
  const risk = rows[0];
  for (const t of r.treatments) {
    await sql.query(
      `INSERT INTO risk_treatments (organization_id, risk_id, title, description, status, due_at) VALUES ($1,$2,$3,$4,'planned',$5)`,
      // risk_treatments.owner_id is a user; the register names a role, which stays in the text.
      [org, risk.id, t.title, t.description, t.dueAt]);
  }
  for (const c of r.controls.filter((x) => known.has(x))) {
    const title = (await sql.query('SELECT title FROM compliance_controls WHERE control_id=$1', [c])).rows[0].title;
    await sql.query(
      `INSERT INTO risk_links (organization_id, risk_id, kind, ref, label) VALUES ($1,$2,'control',$3,$4) ON CONFLICT DO NOTHING`,
      [org, risk.id, c, `${c} · ${title}`]);
  }
  await sql.query(
    `INSERT INTO risk_history (organization_id, risk_id, kind, inherent_score, residual_score, target_score,
        residual_likelihood, residual_impact, status, note, methodology)
     VALUES ($1,$2,'created',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [org, risk.id, risk.inherent_score, risk.residual_score, risk.target_score, r.residual.likelihood, r.residual.impact, status,
      `Imported from the GDAP configuration risk register (SBS-GRC-RR-GDAP v1.0, ${r.registerId}).`, risk.methodology]);
  return { org, id: risk.id as string, ref: r.registerId };
}

if (APPLY) {
  // After COMMIT, so a rolled-back run leaves no audit rows claiming an import that never happened.
  for (const c of created) {
    await audit(null, { action: 'risk.import.gdap', organizationId: c.org, resourceType: 'risk', resourceId: c.id, detail: { source: GDAP_SOURCE, ref: c.ref } });
  }
  console.log(`\nRESULT created ${created.length} risks`);
}
process.exit(0);
