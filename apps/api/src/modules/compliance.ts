// Compliance control coverage + tamper-evident evidence package (docs/nexus/08 §Q-R).
// Coverage is computed at read time from immutable sources (audit_logs hash-chain,
// posture_findings, conmon_runs); evidence is never a separately-writable ledger.
import { createHash } from 'node:crypto';
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type ControlStatus = 'satisfied' | 'partial' | 'gap';

export interface ControlSignal {
  mapped: number; // number of evidence mappings for the control
  satisfied: number; // how many are currently satisfied
}

/** Pure classification of a control's status from its evidence tally. */
export function classifyControl(s: ControlSignal): ControlStatus {
  if (s.mapped === 0 || s.satisfied === 0) return 'gap';
  if (s.satisfied >= s.mapped) return 'satisfied';
  return 'partial';
}

interface ControlRow {
  control_id: string;
  framework: string;
  family: string;
  title: string;
}
interface MappingRow {
  control_id: string;
  source: 'audit_action' | 'posture_domain' | 'conmon_check';
  source_key: string;
}

/** Evaluate one mapping against the current org state; returns true if satisfied. */
async function evaluateMapping(sql: Sql, orgId: string, m: MappingRow): Promise<boolean> {
  if (m.source === 'audit_action') {
    const { rows } = await sql.query(
      `SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action=$2 LIMIT 1`,
      [orgId, m.source_key],
    );
    return rows.length > 0;
  }
  if (m.source === 'posture_domain') {
    const { rows } = await sql.query(
      `SELECT count(*)::int AS n FROM posture_findings
        WHERE organization_id=$1 AND domain=$2
          AND status NOT IN ('remediated','closed','accepted')`,
      [orgId, m.source_key],
    );
    return rows[0].n === 0; // satisfied when no open findings in the domain
  }
  // conmon_check: latest run for this check must be a pass
  const { rows } = await sql.query(
    `SELECT result FROM conmon_runs
      WHERE organization_id=$1 AND check_key=$2
      ORDER BY ran_at DESC LIMIT 1`,
    [orgId, m.source_key],
  );
  return rows[0]?.result === 'pass';
}

export interface ControlCoverage extends ControlRow {
  mapped: number;
  satisfied: number;
  status: ControlStatus;
}

/** Per-control coverage for an org, computed from mapped evidence. */
export async function controlCoverage(actor: Principal, orgId: string): Promise<ControlCoverage[]> {
  authorize(actor, 'compliance.read', { organizationId: orgId });
  const { controls, mappings } = await withSystemContext(async (sql) => {
    const controls = (
      await sql.query<ControlRow>('SELECT control_id, framework, family, title FROM compliance_controls ORDER BY control_id')
    ).rows;
    const mappings = (await sql.query<MappingRow>('SELECT control_id, source, source_key FROM control_mappings')).rows;
    return { controls, mappings };
  });

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const out: ControlCoverage[] = [];
    for (const c of controls) {
      const ms = mappings.filter((m) => m.control_id === c.control_id);
      let satisfied = 0;
      for (const m of ms) if (await evaluateMapping(sql, orgId, m)) satisfied++;
      out.push({ ...c, mapped: ms.length, satisfied, status: classifyControl({ mapped: ms.length, satisfied }) });
    }
    return out;
  });
}

export interface EvidencePackage {
  organization_id: string;
  generated_at: string;
  controls: ControlCoverage[];
  summary: { satisfied: number; partial: number; gap: number };
  manifest_sha256: string;
}

/** Assemble a hash-stamped evidence package for an org. Read-only; itself audited. */
export async function evidencePackage(actor: Principal, orgId: string): Promise<EvidencePackage> {
  authorize(actor, 'compliance.read', { organizationId: orgId });
  const controls = await controlCoverage(actor, orgId);
  const summary = {
    satisfied: controls.filter((c) => c.status === 'satisfied').length,
    partial: controls.filter((c) => c.status === 'partial').length,
    gap: controls.filter((c) => c.status === 'gap').length,
  };
  const generated_at = new Date().toISOString();
  const body = JSON.stringify({ organization_id: orgId, generated_at, controls, summary });
  const manifest_sha256 = createHash('sha256').update(body).digest('hex');
  await audit(actor, {
    action: 'compliance.evidence_export',
    organizationId: orgId,
    resourceType: 'organization',
    resourceId: orgId,
    detail: { manifest_sha256, ...summary },
  });
  return { organization_id: orgId, generated_at, controls, summary, manifest_sha256 };
}

export interface RequestExceptionInput {
  findingId: string;
  justification: string;
  compensatingControl?: string;
  expiresAt?: string;
  organizationId?: string; // required for agent-initiated
}

/** Request a posture exception (SoD: a different principal approves). */
export async function requestException(actor: Principal, input: RequestExceptionInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required for agent-initiated exceptions');
  authorize(actor, 'posture.request_exception', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const f = (await sql.query('SELECT id FROM posture_findings WHERE id=$1 AND organization_id=$2', [input.findingId, orgId])).rows[0];
    if (!f) throw Errors.notFound('finding not found');
    const { rows } = await sql.query(
      `INSERT INTO posture_exceptions
         (organization_id, finding_id, requested_by, justification, compensating_control, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, input.findingId, actor.id, input.justification, input.compensatingControl ?? null, input.expiresAt ?? null],
    );
    const ex = rows[0];
    await audit(actor, { action: 'posture.exception.request', organizationId: orgId, resourceType: 'posture_exception', resourceId: ex.id, detail: { findingId: input.findingId } });
    publish('posture.exception_requested', orgId, { exception_id: ex.id, finding_id: input.findingId, org_id: orgId });
    return ex;
  });
}

/** Approve or reject a posture exception. Enforces separation of duties. */
export async function decideException(actor: Principal, exceptionId: string, approve: boolean) {
  authorize(actor, 'posture.approve_exception');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const ex = (await sql.query('SELECT * FROM posture_exceptions WHERE id=$1', [exceptionId])).rows[0];
    if (!ex) throw Errors.notFound('exception not found');
    if (ex.status !== 'requested') throw Errors.conflict(`exception already ${ex.status}`);
    if (ex.requested_by === actor.id) throw Errors.forbidden('separation of duties: requester cannot approve');
    const status = approve ? 'approved' : 'rejected';
    await sql.query('UPDATE posture_exceptions SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3', [status, actor.id, exceptionId]);
    if (approve) {
      // Accepting an exception moves the underlying finding to 'accepted'.
      await sql.query("UPDATE posture_findings SET status='accepted' WHERE id=$1", [ex.finding_id]);
    }
    await audit(actor, { action: `posture.exception.${status}`, organizationId: ex.organization_id, resourceType: 'posture_exception', resourceId: exceptionId, detail: { findingId: ex.finding_id } });
    publish(approve ? 'posture.exception_approved' : 'posture.exception_rejected', ex.organization_id, { exception_id: exceptionId, finding_id: ex.finding_id });
    return { status };
  });
}
