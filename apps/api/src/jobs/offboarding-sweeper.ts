// Fires approved offboarding plans at the instant HR instructed.
//
// THE INVERSION, and it is deliberate — do not "fix" this into consistency with provisioning.
//
// The provisioning engine refuses to execute when the rebuilt plan no longer matches the
// approved fingerprint, because creating the wrong account is worse than creating nothing.
// Offboarding is the opposite: FAILING TO DISABLE A TERMINATED EMPLOYEE IS THE DANGEROUS
// OUTCOME. So when a plan has drifted between approval and the scheduled moment, this job still
// blocks sign-in and revokes sessions — steps that make the account safe and destroy no data —
// and halts everything touching licences, groups or the mailbox for a human to review.
//
// Spec: docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md
import { withSystemContext, type Sql } from '../db/pool.js';
import { logger } from '../logger.js';
import { planOffboard, offboardFingerprint } from '../modules/offboarding/planner.js';
import { executeOffboardPlan } from '../modules/offboarding/executor.js';
import { readOffboardTenantState, buildOffboardOps } from '../modules/offboarding/index.js';

/** Bounded so one sweep cannot monopolise Graph throttling budget or a database connection. */
const CLAIM_BATCH = 25;

interface ClaimedRun {
  id: string;
  ticket_id: string;
  organization_id: string;
  plan: { fingerprint?: string } | null;
}

export async function sweepDueOffboardings(
  now: Date = new Date(),
): Promise<{ claimed: number; executed: number; needsReview: number }> {
  let executed = 0;
  let needsReview = 0;

  // SKIP LOCKED is what makes concurrent sweepers safe — two app instances, or the old and new
  // container overlapping during a rolling deploy. A row already claimed by another transaction
  // is passed over rather than waited on, so a termination is never executed twice.
  const due = await withSystemContext(async (sql: Sql) => {
    const { rows } = await sql.query(
      `UPDATE provisioning_runs SET status = 'running', started_at = now()
        WHERE id IN (
          SELECT id FROM provisioning_runs
           WHERE kind = 'offboarding' AND status = 'scheduled' AND scheduled_for <= $1
           ORDER BY scheduled_for
           FOR UPDATE SKIP LOCKED
           LIMIT ${CLAIM_BATCH}
        )
        RETURNING id, ticket_id, organization_id, plan`,
      [now.toISOString()],
    );
    return rows as ClaimedRun[];
  });

  for (const run of due) {
    try {
      // Rebuild from CURRENT tenant state. The approved plan is a record of what was agreed, not
      // a script to replay blindly against a directory that may have moved on.
      const state = await readOffboardTenantState(run.ticket_id);
      const fresh = planOffboard(state);
      // Blockers on the rebuilt plan count as drift: whatever was approved, THIS is not
      // executable, so only the security steps may run.
      const drifted = offboardFingerprint(fresh) !== run.plan?.fingerprint
        || fresh.blockers.length > 0;

      if (!state.user) {
        await finish(run, 'failed', 'the account no longer exists in the tenant');
        continue;
      }

      const ops = await buildOffboardOps(run.id, run.organization_id);
      const outcomes = await executeOffboardPlan(
        fresh, state.user.id, ops, { onlySecuritySteps: drifted },
      );

      if (drifted) {
        // Read the outcomes before claiming anything. Reporting "sign-in blocked and sessions
        // revoked" while the account is still enabled is worse than reporting a failure: it
        // tells the desk the dangerous half is handled when it is not.
        const failedSecurity = outcomes.find((o) => o.status === 'failed');
        if (failedSecurity) {
          await finish(run, 'failed',
            `plan changed since approval AND the account could not be secured — `
            + `${failedSecurity.key}: ${failedSecurity.error ?? 'step failed'}`);
        } else {
          needsReview += 1;
          logger.warn(
            { runId: run.id, ticketId: run.ticket_id },
            'offboarding plan changed since approval; blocked sign-in and revoked sessions, halted the rest for review',
          );
          await finish(run, 'needs_review',
            'plan changed since approval; sign-in blocked and sessions revoked, data-affecting steps halted');
        }
      } else if (outcomes.some((o) => o.status === 'failed')) {
        const failed = outcomes.find((o) => o.status === 'failed')!;
        await finish(run, 'failed', `${failed.key}: ${failed.error ?? 'step failed'}`);
      } else if (outcomes.some((o) => o.status === 'awaiting_manual')) {
        // The mailbox conversion is waiting on a human. Not a failure — the run is paused, and
        // nothing past that step may proceed until it is confirmed.
        needsReview += 1;
        await finish(run, 'needs_review', 'waiting on the manual mailbox conversion');
      } else {
        executed += 1;
        await finish(run, 'succeeded', null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sweep failed';
      logger.error({ err, runId: run.id }, 'offboarding sweep failed');
      // Never leave a claimed run stuck in 'running': the next sweep would skip it and nobody
      // would know the termination had not completed.
      await finish(run, 'failed', message);
    }
  }

  return { claimed: due.length, executed, needsReview };
}

async function finish(run: ClaimedRun, status: string, error: string | null): Promise<void> {
  await withSystemContext(async (sql: Sql) => {
    // organization_id in the predicate: RLS is not inherited, and a status write must not be
    // able to land on another tenant's run.
    await sql.query(
      `UPDATE provisioning_runs
          SET status = $2, error = $3, finished_at = now()
        WHERE id = $1 AND organization_id = $4`,
      [run.id, status, error, run.organization_id],
    );
  });
}

/**
 * Starts the sweep loop. One minute by default: a termination is time-sensitive, and this is a
 * cheap indexed query against a partial index that only contains runs actually waiting to fire.
 *
 * A throw inside a tick must never take the process down — an offboarding that fails is a
 * problem, an API that dies with it is a bigger one.
 */
export function startOffboardingSweeper(intervalMs = 60_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const out = await sweepDueOffboardings(new Date());
      if (out.claimed > 0) {
        logger.info(out, 'offboarding sweep completed');
      }
    } catch (err) {
      logger.error({ err }, 'offboarding sweep tick failed');
    }
  };
  return setInterval(tick, intervalMs);
}
