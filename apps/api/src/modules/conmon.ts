// Continuous Monitoring (ConMon) — NIST SP 800-137 / FedRAMP-aligned scheduled checks.
// Runs the conmon_checks catalog per customer, records runs, and raises posture findings
// (idempotently) that drive risk-based remediation tickets. See
// docs/nexus/workflows/service-desk-workflows.md §4.
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { logger } from '../logger.js';
import type { Principal } from '../types.js';

// Checks that "fail" in this reference (would be real probes against Graph/Defender/etc).
const FAILING = new Set(['mfa_coverage', 'vuln_scan', 'email_security']);

function riskScore(sev: string): number {
  return sev === 'critical' ? 40 : sev === 'high' ? 25 : sev === 'moderate' ? 12 : 5;
}

/** Run all active checks for one org. Idempotent on findings (no duplicate open finding). */
async function runForOrg(sql: Sql, orgId: string, checks: any[]) {
  const results: Array<{ check: string; result: string }> = [];
  for (const c of checks) {
    if (FAILING.has(c.key)) {
      const title = `ConMon: ${c.name}`;
      const exists = (
        await sql.query(
          "SELECT 1 FROM posture_findings WHERE organization_id=$1 AND title=$2 AND status NOT IN ('remediated','closed','accepted')",
          [orgId, title],
        )
      ).rows[0];
      let findingId: string | null = null;
      if (!exists) {
        const profile = (await sql.query('SELECT id FROM posture_profiles WHERE organization_id=$1 LIMIT 1', [orgId])).rows[0];
        const f = (
          await sql.query(
            `INSERT INTO posture_findings (organization_id, profile_id, title, domain, severity, risk_score, status, remediation_due_at)
             VALUES ($1,$2,$3,$4,$5,$6,'confirmed', now() + interval '30 days') RETURNING id`,
            [orgId, profile?.id ?? null, title, c.domain, c.severity, riskScore(c.severity)],
          )
        ).rows[0];
        findingId = f.id;
        publish('posture.finding_created', orgId, { finding_id: findingId, org_id: orgId, severity: c.severity, domain: c.domain });
      }
      await sql.query(
        `INSERT INTO conmon_runs (organization_id, check_key, result, finding_id, detail) VALUES ($1,$2,'finding',$3,$4)`,
        [orgId, c.key, findingId, { control_refs: c.control_refs }],
      );
      results.push({ check: c.key, result: 'finding' });
    } else {
      await sql.query(
        `INSERT INTO conmon_runs (organization_id, check_key, result, detail) VALUES ($1,$2,'pass',$3)`,
        [orgId, c.key, { control_refs: c.control_refs }],
      );
      results.push({ check: c.key, result: 'pass' });
    }
  }
  return results;
}

/** Agent-triggered ConMon run across in-scope orgs (RLS-scoped). */
export async function run(actor: Principal, orgId?: string) {
  authorize(actor, 'posture.finding.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const checks = (await sql.query('SELECT * FROM conmon_checks WHERE active')).rows;
    const orgs = orgId
      ? [{ id: orgId }]
      : (await sql.query('SELECT id FROM organizations')).rows; // RLS scopes to assigned orgs
    let total = 0;
    let findings = 0;
    for (const o of orgs) {
      const r = await runForOrg(sql, o.id, checks);
      total += r.length;
      findings += r.filter((x) => x.result === 'finding').length;
    }
    await audit(actor, { action: 'conmon.run', detail: { orgs: orgs.length, checks: total, findings } });
    return { orgs: orgs.length, checks: total, findings };
  });
}

export async function listRuns(actor: Principal, orgId?: string) {
  authorize(actor, 'posture.read', orgId ? { organizationId: orgId } : {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const params: unknown[] = [];
    let where = '';
    if (orgId) {
      params.push(orgId);
      where = 'WHERE r.organization_id=$1';
    }
    const { rows } = await sql.query(
      `SELECT r.check_key, r.result, r.ran_at, c.name, c.domain, c.severity, c.control_refs
         FROM conmon_runs r LEFT JOIN conmon_checks c ON c.key = r.check_key
         ${where}
        ORDER BY r.ran_at DESC LIMIT 50`,
      params,
    );
    return rows;
  });
}

/** Scheduled system run across ALL orgs (bypasses RLS via owner role). */
export function startConMonScheduler(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        const checks = (await sql.query('SELECT * FROM conmon_checks WHERE active')).rows;
        const orgs = (await sql.query("SELECT id FROM organizations WHERE status='active'")).rows;
        for (const o of orgs) await runForOrg(sql, o.id, checks);
        logger.info({ orgs: orgs.length, checks: checks.length }, 'ConMon scheduled run complete');
      });
    } catch (err) {
      logger.error({ err }, 'ConMon scheduled run failed');
    }
  };
  setTimeout(tick, 60_000); // first run a minute after boot (idempotent)
  return setInterval(tick, intervalMs);
}
