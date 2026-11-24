// One-time import of the retired SharePoint support lists (Tickets, Change Request) into Nexus
// as CLOSED historical records, and of the SBSFederal risk-register spreadsheet into the live
// risk register. DRY RUN unless --apply is passed.
//
// Writes straight to the tables rather than through createTicket/createChange on purpose: those
// paths start SLA clocks, move the ticket to triage, publish ticket.created/acknowledged (which
// mails the requester) and change.created. None of that may happen for a ticket closed months ago.
//
// Idempotent: every row carries external_ref; a row already imported is skipped, never rewritten.
// Attribution: the audit actor is the system (null), the honest actor for a script.
//
// Usage (from apps/api):
//   ORG_ID=<sbs federal org uuid> npx tsx src/scripts/import-legacy-tickets.ts \
//     --tickets ~/Downloads/Tickets.csv --changes "~/Downloads/Change Request.csv" --risks ~/Downloads/RiskRegister.csv   # dry run
//   ... --apply
import { readFileSync } from 'node:fs';
import { withSystemContext } from '../db/pool.js';
import { audit } from '../modules/audit.js';
import { derivePriority } from '../modules/tickets.js';
import { nextReviewAt } from '../modules/risk-scoring.js';
import {
  LEGACY_SOURCE, csvRecords, mapLegacyRow, mapLegacyChange, legacyRiskRows, mapLegacyRisk, personKey,
  type LegacyTicket, type LegacyChange, type LegacyRisk,
} from '../modules/legacy-ticket-import.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const ORG_ID = process.env.ORG_ID ?? '';
const ticketsPath = arg('--tickets');
const changesPath = arg('--changes');
const risksPath = arg('--risks');
if (!ORG_ID) { console.error('ORG_ID is required'); process.exit(1); }
if (!ticketsPath && !changesPath && !risksPath) { console.error('pass --tickets, --changes and/or --risks <csv>'); process.exit(1); }

const tickets: LegacyTicket[] = ticketsPath ? csvRecords(readFileSync(ticketsPath, 'utf8')).map(mapLegacyRow) : [];
const changes: LegacyChange[] = changesPath ? csvRecords(readFileSync(changesPath, 'utf8')).map(mapLegacyChange) : [];
const risks: LegacyRisk[] = risksPath ? legacyRiskRows(readFileSync(risksPath, 'utf8')).map(mapLegacyRisk) : [];
const riskRef = (r: LegacyRisk) => `${LEGACY_SOURCE}:SBSFederal-RiskRegister:${r.legacyId}`;

const result = await withSystemContext(async (sql) => {
  const org = (await sql.query('SELECT id, name FROM organizations WHERE id=$1', [ORG_ID])).rows[0];
  if (!org) throw new Error(`organization ${ORG_ID} not found`);
  console.log(`organization : ${org.name} (${org.id})`);
  console.log(`mode         : ${APPLY ? 'APPLY' : 'dry run (pass --apply to write)'}`);

  // People are matched by name within the org: "Wise, Taylor" -> users.display_name "Taylor Wise",
  // falling back to the email local part (taylor.wise@...). Unmatched names stay as text.
  const users = (await sql.query(
    `SELECT id, display_name, email FROM users WHERE organization_id=$1`, [ORG_ID])).rows as Array<{ id: string; display_name: string | null; email: string }>;
  const byKey = new Map<string, string>();
  for (const u of users) {
    if (u.display_name) byKey.set(personKey(u.display_name), u.id);
    const local = u.email.split('@')[0];
    if (!byKey.has(personKey(local))) byKey.set(personKey(local), u.id);
  }
  const who = (name: string | null) => (name ? byKey.get(personKey(name)) ?? null : null);

  const seenT = new Set((await sql.query(
    `SELECT external_ref FROM tickets WHERE organization_id=$1 AND external_source=$2`, [ORG_ID, LEGACY_SOURCE])).rows.map((r: any) => r.external_ref));
  const seenC = new Set((await sql.query(
    `SELECT external_ref FROM changes WHERE organization_id=$1 AND external_source=$2`, [ORG_ID, LEGACY_SOURCE])).rows.map((r: any) => r.external_ref));

  const seenR = new Set((await sql.query(
    `SELECT external_ref FROM risks WHERE organization_id=$1 AND external_source=$2`, [ORG_ID, LEGACY_SOURCE])).rows.map((r: any) => r.external_ref));
  const knownControls = new Map<string, string>((await sql.query('SELECT control_id, title FROM compliance_controls')).rows
    .map((c: any) => [String(c.control_id).toUpperCase(), c.title]));
  // Second guard against duplication: records someone already entered by hand in Nexus carry no
  // external_ref, so match them on content: tickets by subject + creation day, changes and risks
  // by title. A match is skipped and reported, never merged or overwritten.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nativeT = new Map<string, string>((await sql.query(
    `SELECT ticket_number, subject, created_at FROM tickets WHERE organization_id=$1 AND external_source IS DISTINCT FROM $2`, [ORG_ID, LEGACY_SOURCE])).rows
    .map((t: any) => [`${norm(t.subject)}|${new Date(t.created_at).toISOString().slice(0, 10)}`, t.ticket_number]));
  const nativeC = new Map<string, string>((await sql.query(
    `SELECT id, title FROM changes WHERE organization_id=$1 AND external_source IS DISTINCT FROM $2`, [ORG_ID, LEGACY_SOURCE])).rows
    .map((c: any) => [norm(c.title), c.id]));
  const nativeR = new Map<string, string>((await sql.query(
    `SELECT risk_number, title FROM risks WHERE organization_id=$1 AND external_source IS DISTINCT FROM $2`, [ORG_ID, LEGACY_SOURCE])).rows
    .map((r: any) => [norm(r.title), `R-${String(r.risk_number).padStart(4, '0')}`]));
  const dupes: string[] = [];
  const keep = <T,>(label: string, existing: string | undefined, item: T) => {
    if (existing) { dupes.push(`${label}  ==  existing ${existing}`); return false; }
    return !!item;
  };
  const newT = tickets.filter((t) => !seenT.has(t.externalRef)
    && keep(`ticket ${t.ticketNumber} "${t.subject.slice(0, 50)}"`, nativeT.get(`${norm(t.subject)}|${t.createdAt.slice(0, 10)}`), t));
  const newC = changes.filter((c) => !seenC.has(c.externalRef)
    && keep(`change "${c.title.slice(0, 50)}"`, nativeC.get(norm(c.title)), c));
  const newR = risks.filter((r) => !seenR.has(riskRef(r))
    && keep(`risk ${r.legacyId} "${r.title.slice(0, 50)}"`, nativeR.get(norm(r.title)), r));
  // Within-file guard: the same source row twice in one export must not become two records.
  for (const [label, refs] of [['ticket', tickets.map((t) => t.externalRef)], ['change', changes.map((c) => c.externalRef)], ['risk', risks.map(riskRef)]] as const) {
    const dup = refs.find((x, i) => refs.indexOf(x) !== i);
    if (dup) throw new Error(`the ${label} file contains the same source row twice (${dup}); refusing to import`);
  }

  console.log(`\ntickets      : ${tickets.length} in file, ${tickets.filter((t) => seenT.has(t.externalRef)).length} already imported, ${newT.length} to create`);
  for (const t of newT) {
    const flags = [
      t.legacyStatus.toLowerCase() !== 'completed' && `was "${t.legacyStatus}"`,
      t.redacted && 'credential redacted',
      t.hadAttachments && 'had attachments (not in export)',
      t.requesterName && !who(t.requesterName) && `requester "${t.requesterName}" unmatched`,
    ].filter(Boolean).join('; ');
    console.log(`  ${t.ticketNumber} ${derivePriority(t.impact, t.urgency)} ${t.type.padEnd(15)} ${t.createdAt.slice(0, 10)} ${t.subject.slice(0, 60)}${flags ? `  [${flags}]` : ''}`);
  }
  console.log(`\nchanges      : ${changes.length} in file, ${changes.filter((c) => seenC.has(c.externalRef)).length} already imported, ${newC.length} to create`);
  for (const c of newC) {
    const flags = [
      c.changeType === 'emergency' && 'emergency',
      c.redacted && 'credential redacted',
      c.createdByName && !who(c.createdByName) && `creator "${c.createdByName}" unmatched`,
    ].filter(Boolean).join('; ');
    console.log(`  ${c.risk.padEnd(6)} ${c.createdAt.slice(0, 10)} ${c.title.slice(0, 70)}${flags ? `  [${flags}]` : ''}`);
  }

  console.log(`\nrisks        : ${risks.length} in file, ${risks.filter((r) => seenR.has(riskRef(r))).length} already imported, ${newR.length} to create`);
  for (const r of newR) {
    const flags = [r.unscored && 'unscored: 3x3 placeholder', r.treatments.length && `${r.treatments.length} treatment(s)`,
      r.controls.length && `controls ${r.controls.map((c) => knownControls.has(c) ? c : `${c}*`).join(',')}`].filter(Boolean).join('; ');
    console.log(`  ${r.legacyId} ${r.status.padEnd(10)} ${r.inherent.likelihood}x${r.inherent.impact}->${r.residual.likelihood}x${r.residual.impact} ${r.title.slice(0, 55)}${flags ? `  [${flags}]` : ''}`);
  }
  if (newR.length) console.log('  (* = control id not in the control library; kept in the description, not linked)');

  console.log(`\nskipped as already present in Nexus (entered by hand): ${dupes.length}`);
  for (const d of dupes) console.log(`  ${d}`);

  // Keep R001 -> R-0001 when the numbers are free; if any is taken, number the whole import after
  // the current maximum so the set stays contiguous (the legacy id is kept in tags/description).
  const takenNums = new Set((await sql.query('SELECT risk_number FROM risks WHERE organization_id=$1', [ORG_ID])).rows.map((x: any) => x.risk_number as number));
  if (newR.some((r) => takenNums.has(r.riskNumber))) {
    let n = Math.max(0, ...takenNums);
    for (const r of newR) { n += 1; r.riskNumber = n; }
    console.log(`\nnote: legacy risk numbers collide with existing risks; importing as R-${String(newR[0]?.riskNumber).padStart(4, '0')} onward`);
  }
  for (const r of newR) if (!r.tags.includes(r.legacyId)) r.tags.push(r.legacyId);

  if (!APPLY) return { ticketIds: [] as string[], changeIds: [] as string[], riskIds: [] as string[] };
  const riskIds: string[] = [];

  const ticketIds: string[] = [];
  const changeIds: string[] = [];
  await sql.query('BEGIN');
  try {
    for (const t of newT) {
      const clash = (await sql.query(
        'SELECT external_ref FROM tickets WHERE organization_id=$1 AND ticket_number=$2', [ORG_ID, t.ticketNumber])).rows[0];
      if (clash) throw new Error(`${t.ticketNumber} already exists in this org with a different origin (${clash.external_ref ?? 'native'})`);
      const requester = who(t.requesterName);
      const { rows } = await sql.query(
        `INSERT INTO tickets
           (organization_id, ticket_number, type, requester_id, affected_user_id, source_channel, subject,
            description, category, impact, urgency, priority, status, tags, custom_fields,
            external_ref, external_source, resolution_code, closure_notes,
            created_at, updated_at, resolved_at, closed_at)
         VALUES ($1,$2,$3,$4,$4,'import',$5,$6,$7,$8,$9,$10,'closed',$11,$12,$13,$14,'legacy_import',$15,$16,$16,NULL,NULL)
         RETURNING id`,
        [
          ORG_ID, t.ticketNumber, t.type, requester, t.subject, t.description, t.category,
          t.impact, t.urgency, derivePriority(t.impact, t.urgency), ['legacy-import'],
          {
            legacy: {
              system: 'SharePoint FederalSupport/Tickets', id: Number(t.legacyId), status: t.legacyStatus,
              created_by: t.requesterName, assigned_to: t.assignedTo, related_issue: t.relatedIssue,
              had_attachments: t.hadAttachments,
            },
          },
          t.externalRef, LEGACY_SOURCE, t.resolution, t.createdAt,
        ],
      );
      const id = rows[0].id as string;
      ticketIds.push(id);
      if (t.notes) {
        await sql.query(
          `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body, created_at)
           VALUES ($1,$2,NULL,'internal',$3,$4)`,
          [ORG_ID, id, `Notes carried over from the legacy SharePoint ticket #${t.legacyId}:\n\n${t.notes}`, t.createdAt],
        );
      }
      await sql.query(
        `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail, created_at)
         VALUES ($1,$2,NULL,'imported',$3,now())`,
        [ORG_ID, id, { source: LEGACY_SOURCE, legacy_id: Number(t.legacyId), legacy_status: t.legacyStatus }],
      );
    }
    for (const c of newC) {
      const { rows } = await sql.query(
        `INSERT INTO changes
           (organization_id, title, description, change_type, risk, impact, status,
            implementation_plan, backout_plan, implementer_id, created_by,
            external_ref, external_source, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5,'closed',$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          ORG_ID, c.title, c.description, c.changeType, c.risk, c.implementationPlan, c.backoutPlan,
          who(c.implementerName), who(c.createdByName), c.externalRef, LEGACY_SOURCE, c.createdAt, c.updatedAt,
        ],
      );
      const id = rows[0].id as string;
      changeIds.push(id);
      if (c.notes) {
        await sql.query(
          `INSERT INTO change_comments (organization_id, change_id, author_id, body, created_at)
           VALUES ($1,$2,NULL,$3,$4)`,
          [ORG_ID, id, `Notes carried over from the legacy SharePoint change request:\n\n${c.notes}`, c.updatedAt],
        );
      }
    }
    for (const r of newR) {
      const now = new Date();
      const { rows } = await sql.query(
        `INSERT INTO risks
           (organization_id, risk_number, title, description, consequence, category, status, strategy, owner_name,
            inherent_likelihood, inherent_impact, residual_likelihood, residual_impact,
            last_reviewed_at, next_review_at, tags, external_ref, external_source, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id, inherent_score, residual_score`,
        [ORG_ID, r.riskNumber, r.title, r.description, r.consequence, r.category, r.status, r.strategy, r.ownerName,
          r.inherent.likelihood, r.inherent.impact, r.residual.likelihood, r.residual.impact,
          now, nextReviewAt(r.residual.likelihood * r.residual.impact, now), r.tags, riskRef(r), LEGACY_SOURCE,
          r.status === 'closed' ? now : null],
      );
      const id = rows[0].id as string;
      riskIds.push(id);
      for (const t of r.treatments) {
        await sql.query(
          `INSERT INTO risk_treatments (organization_id, risk_id, title, status, completed_at) VALUES ($1,$2,$3,$4,$5)`,
          [ORG_ID, id, t.title, t.status, t.status === 'done' ? now : null]);
      }
      for (const c of r.controls) {
        const title = knownControls.get(c);
        if (title) await sql.query(
          `INSERT INTO risk_links (organization_id, risk_id, kind, ref, label) VALUES ($1,$2,'control',$3,$4) ON CONFLICT DO NOTHING`,
          [ORG_ID, id, c, `${c} · ${title}`]);
      }
      await sql.query(
        `INSERT INTO risk_history (organization_id, risk_id, kind, inherent_score, residual_score, residual_likelihood, residual_impact, status, note)
         VALUES ($1,$2,'created',$3,$4,$5,$6,$7,$8)`,
        [ORG_ID, id, rows[0].inherent_score, rows[0].residual_score, r.residual.likelihood, r.residual.impact, r.status,
          `Imported from the SBSFederal risk register spreadsheet (${r.legacyId})${r.note ? `. Legacy comment: ${r.note}` : ''}`]);
    }
    await sql.query('COMMIT');
  } catch (err) {
    await sql.query('ROLLBACK');
    throw err;
  }
  return { ticketIds, changeIds, riskIds };
});

if (APPLY) {
  // After COMMIT, so a rolled-back run leaves no audit rows claiming an import that never happened.
  for (const id of result.ticketIds) {
    await audit(null, { action: 'ticket.import.legacy', organizationId: ORG_ID, resourceType: 'ticket', resourceId: id, detail: { source: LEGACY_SOURCE } });
  }
  for (const id of result.changeIds) {
    await audit(null, { action: 'change.import.legacy', organizationId: ORG_ID, resourceType: 'change', resourceId: id, detail: { source: LEGACY_SOURCE } });
  }
  for (const id of result.riskIds) {
    await audit(null, { action: 'risk.import.legacy', organizationId: ORG_ID, resourceType: 'risk', resourceId: id, detail: { source: LEGACY_SOURCE } });
  }
  console.log(`\nRESULT created ${result.ticketIds.length} tickets (closed), ${result.changeIds.length} changes (closed), ${result.riskIds.length} risks`);
}
process.exit(0);
