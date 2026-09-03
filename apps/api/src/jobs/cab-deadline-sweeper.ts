// Periodic CAB deadline sweep (spec 2026-06-25 "Deadline escalation"). Runs every few
// minutes, finds `cab_review` changes past their `vote_deadline` whose quorum has not
// been reached, and emits `change.vote_overdue` (which notifies the board chair — see
// notifications.ts / notifications-recipients.ts) exactly once per change.
//
// Deliberately NOT a decision-maker: this job never auto-approves, auto-rejects, or
// otherwise transitions the change. A vote timing out is a fact about the board's
// turnout, not a verdict on the change, and deciding a production change because a
// timer expired is not a call this system gets to make. It notifies the chair and stops.
//
// Structure mirrors sla-sweeper.ts (interval, withSystemContext, try/catch-and-log per
// tick). Idempotency differs deliberately: sla-sweeper uses an in-memory Set because SLA
// state is cheaply re-derived every tick and a duplicate warning after a restart is a
// same-severity repeat. A CAB vote_deadline runs on business-day timescales (3 business
// days normal, 4h emergency — see voteDeadlineFor) relative to how often the API process
// restarts (deploys, container recycles), so an in-memory guard would re-page the chair
// on every restart for as long as the change stays overdue. Instead this job persists a
// durable marker (`changes.vote_overdue_notified_at`, migration 0063) the first time it
// notifies a change, via a conditional UPDATE ... WHERE vote_overdue_notified_at IS NULL
// that also serializes concurrent sweeper ticks (only one can win the row). The marker
// survives restarts: a change is escalated once for its whole overdue lifetime, not once
// per process lifetime.
import { withSystemContext, type Sql } from '../db/pool.js';
import { isVoteOverdue, type VoteRow } from '../modules/changes.js';
import { publish } from '../events/bus.js';
import { logger } from '../logger.js';

interface CabReviewRow {
  id: string;
  organization_id: string;
  title: string;
  status: string;
  vote_deadline: string | null;
  cab_quorum: number | null;
}

export function startCabDeadlineSweeper(intervalMs = 300_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      // Captured once per tick so every row in this pass is judged against the same
      // instant (the pure predicate takes `now` as a parameter precisely so this can be
      // pinned here, rather than each row implicitly re-reading the app clock — or, worse,
      // mixing the app clock with the `now()` the SQL prefilter below uses on the DB side).
      const now = new Date();
      await withSystemContext(async (sql: Sql) => {
        // Candidates: still cab_review, has a deadline, not yet notified. The actual
        // quorum-unmet check happens per-row below via the pure predicate — this WHERE
        // clause is just the cheap prefilter (mirrors sla-sweeper's `state IN (...)`), so
        // it uses the DB's own now() rather than the `now` captured above; the predicate
        // is the authority on "is this actually overdue," not this prefilter.
        const { rows } = await sql.query<CabReviewRow>(
          `SELECT id, organization_id, title, status, vote_deadline, cab_quorum
             FROM changes
            WHERE status = 'cab_review'
              AND vote_deadline IS NOT NULL
              AND vote_deadline < now()
              AND vote_overdue_notified_at IS NULL`,
        );
        for (const change of rows) {
          try {
            const { rows: voteRows } = await sql.query<VoteRow>(
              'SELECT vote, weight, ad_hoc FROM change_votes WHERE change_id = $1',
              [change.id],
            );
            if (!isVoteOverdue(change, voteRows, now)) continue;

            // Conditional UPDATE: wins the row for exactly one sweeper tick/process, and is
            // the durable idempotency guard (persists across restarts, unlike an in-memory
            // Set — see module comment).
            const { rowCount } = await sql.query(
              `UPDATE changes SET vote_overdue_notified_at = now()
                WHERE id = $1 AND vote_overdue_notified_at IS NULL`,
              [change.id],
            );
            if (!rowCount) continue; // another tick/process already claimed it

            publish(
              'change.vote_overdue',
              change.organization_id,
              { change_id: change.id, vote_deadline: change.vote_deadline },
              { idempotencyKey: `change.vote_overdue:${change.id}` },
            );
          } catch (err) {
            // One change's failure (a bad row, a transient query error) must not cost the
            // rest of this tick's changes their escalation. The marker is only ever set on
            // the success path above, so a failed row simply retries next tick — self-healing,
            // like sla-sweeper's per-tick try/catch, just scoped to one row instead of all of them.
            logger.error({ err, changeId: change.id }, 'cab deadline sweeper: change failed, continuing');
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'cab deadline sweeper tick failed');
    }
  };
  // first run shortly after boot, then on interval
  setTimeout(tick, 5_000);
  return setInterval(tick, intervalMs);
}
