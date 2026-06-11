// Posture database (docs/nexus/05 §I). Findings, scoring, and the finding->ticket
// bridge with a remediation SLA. First-class system-of-record linked to tickets.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

const SEVERITY_WEIGHT: Record<string, number> = { critical: 40, high: 25, moderate: 12, low: 5, info: 1 };
const REMEDIATION_DAYS: Record<string, number> = { critical: 7, high: 30, moderate: 90, low: 180, info: 365 };

export function riskScore(severity: string): number {
  return SEVERITY_WEIGHT[severity] ?? 10;
}

/** Overall posture score (0-100, higher better) = 100 - sum(open finding weights), clamped. */
export async function computeScore(actor: Principal, orgId: string): Promise<number> {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT severity, count(*)::int AS n FROM posture_findings
        WHERE organization_id=$1 AND status NOT IN ('remediated','closed','accepted')
        GROUP BY severity`,
      [orgId],
    );
    let penalty = 0;
    for (const r of rows) penalty += (SEVERITY_WEIGHT[r.severity] ?? 10) * Number(r.n);
    const score = Math.max(0, Math.min(100, 100 - penalty));
    await sql.query(`UPDATE posture_profiles SET overall_score=$1 WHERE organization_id=$2`, [score, orgId]);
    return score;
  });
}

export function grade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export async function listFindings(actor: Principal, orgId: string, filter: { severity?: string; status?: string } = {}) {
  authorize(actor, 'posture.read', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where = ['organization_id=$1'];
    const params: unknown[] = [orgId];
    if (filter.severity) { params.push(filter.severity); where.push(`severity=$${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status=$${params.length}`); }
    const { rows } = await sql.query(
      `SELECT * FROM posture_findings WHERE ${where.join(' AND ')} ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'moderate' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         created_at DESC`,
      params,
    );
    return rows;
  });
}

export interface CreateFindingInput {
  organizationId: string;
  title: string;
  domain: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'info';
  spawnTicket?: boolean;
}

export async function createFinding(actor: Principal, input: CreateFindingInput) {
  authorize(actor, 'posture.finding.manage', { organizationId: input.organizationId });
  const orgId = input.organizationId;
  const due = new Date(Date.now() + (REMEDIATION_DAYS[input.severity] ?? 90) * 86_400_000);

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const profile = (await sql.query('SELECT id FROM posture_profiles WHERE organization_id=$1 LIMIT 1', [orgId])).rows[0];
    const { rows } = await sql.query(
      `INSERT INTO posture_findings
         (organization_id, profile_id, title, domain, severity, risk_score, status, remediation_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7) RETURNING *`,
      [orgId, profile?.id ?? null, input.title, input.domain, input.severity, riskScore(input.severity), due],
    );
    const finding = rows[0];
    await audit(actor, { action: 'posture.finding.create', organizationId: orgId, resourceType: 'posture_finding', resourceId: finding.id, detail: { severity: input.severity } });
    publish('posture.finding_created', orgId, { finding_id: finding.id, org_id: orgId, severity: input.severity, domain: input.domain });
    return finding;
  });
}

/** Promote a confirmed finding into a remediation ticket with a remediation SLA (docs/nexus/04 §H.11). */
export async function findingToTicket(actor: Principal, findingId: string) {
  authorize(actor, 'posture.finding.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const f = (await sql.query('SELECT * FROM posture_findings WHERE id=$1', [findingId])).rows[0];
    if (!f) throw Errors.notFound('finding not found');
    if (f.linked_ticket_id) throw Errors.conflict('finding already linked to a ticket');

    const prefix = (await sql.query('SELECT left(upper(name),4) AS p FROM organizations WHERE id=$1', [f.organization_id])).rows[0].p;
    const n = (await sql.query(`SELECT count(*)::int+1 AS n FROM tickets WHERE organization_id=$1`, [f.organization_id])).rows[0].n;
    const priority = f.severity === 'critical' ? 'P1' : f.severity === 'high' ? 'P2' : 'P3';

    const t = (
      await sql.query(
        `INSERT INTO tickets (organization_id, ticket_number, type, source_channel, subject, description,
            impact, urgency, priority, status, resolution_due_at, linked_posture_finding_id, tags)
         VALUES ($1,$2,'posture_finding','posture',$3,$4,2,2,$5,'triage',$6,$7,ARRAY['security','posture'])
         RETURNING *`,
        [
          f.organization_id,
          `${prefix}-${String(n).padStart(6, '0')}`,
          `Remediate: ${f.title}`,
          `Auto-created from posture finding (${f.severity}/${f.domain}).`,
          priority,
          f.remediation_due_at,
          findingId,
        ],
      )
    ).rows[0];

    await sql.query(
      `INSERT INTO sla_instances (organization_id, ticket_id, metric, due_at, state)
       VALUES ($1,$2,'remediation',$3,'running')`,
      [f.organization_id, t.id, f.remediation_due_at],
    );
    await sql.query('UPDATE posture_findings SET status=$1, linked_ticket_id=$2 WHERE id=$3', ['in_remediation', t.id, findingId]);

    await audit(actor, { action: 'posture.finding.to_ticket', organizationId: f.organization_id, resourceType: 'ticket', resourceId: t.id, detail: { findingId } });
    publish('ticket.created', f.organization_id, { ticket_id: t.id, org_id: f.organization_id, type: 'posture_finding', priority, channel: 'posture' });
    return t;
  });
}
