// Closes tickets that have sat in Resolved for AUTO_CLOSE_RESOLVED_DAYS (default 7; 0 = off).
//
// The close is the SAME close a person makes. Each ticket goes through applyTransition — the body
// of tickets.transition() — so it gets the workflow check, the closed_at stamp, a status_changed
// ticket_event, an audit row and ticket.closed, attributed to the system (actor NULL). Nothing
// here writes tickets itself; a second copy of the transition SQL would drift from the first.
//
// Closing is not a dead end: closed -> reopened is allowed, and CSAT keeps accepting a survey
// on a closed ticket, so a requester who answers late or comes back after the window loses
// nothing. The automation engine's close_stale_ticket action is a different thing (a gated,
// rule-driven close of any non-closed ticket) and is deliberately left alone.
//
// Structure mirrors offboarding-sweeper.ts: system context across all orgs, a bounded batch,
// SKIP LOCKED so overlapping instances never close the same ticket twice, and one ticket's
// failure costing only that ticket.
import { withSystemContext, type Sql } from '../db/pool.js';
import { applyTransition } from '../modules/tickets.js';
import { resolveTransitions, isTransitionAllowed } from '../modules/workflows.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Bounded so one sweep cannot hold the admin pool for a large backlog; the rest go next tick. */
const CLOSE_BATCH = 200;

/** The instant a resolve must predate to be closed, or null when the job is switched off. Pure. */
export function autoCloseCutoff(now: Date, days: number): Date | null {
  if (!(days > 0)) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Is this ticket due to close? Pure. The status is the authority: a ticket reopened since it was
 * selected is not Resolved any more, whatever stamp it carried a moment ago.
 */
export function isDueForAutoClose(
  t: { status: string; resolved_at: string | Date | null },
  cutoff: Date,
): boolean {
  if (t.status !== 'resolved' || t.resolved_at == null) return false;
  const at = new Date(t.resolved_at).getTime();
  return Number.isFinite(at) && at < cutoff.getTime();
}

export async function sweepAutoCloseResolved(
  now: Date,
  days: number,
): Promise<{ closed: number; skipped: number; failed: number }> {
  let closed = 0; let skipped = 0; let failed = 0;
  const cutoff = autoCloseCutoff(now, days);
  if (!cutoff) return { closed, skipped, failed };

  const candidates = await withSystemContext(async (sql: Sql) => {
    // Workflow first, per (org, type). Filtering only per ticket would let a backlog of tickets
    // whose workflow forbids resolved -> closed sit at the head of the oldest-first batch every
    // tick and starve the closable ones behind it forever.
    const { rows: pairs } = await sql.query(
      `SELECT DISTINCT organization_id, type FROM tickets
        WHERE status = 'resolved' AND resolved_at < $1`,
      [cutoff.toISOString()],
    );
    const orgs: string[] = [];
    const types: string[] = [];
    for (const p of pairs as Array<{ organization_id: string; type: string }>) {
      const map = await resolveTransitions(sql, p.organization_id, p.type);
      if (isTransitionAllowed(map, 'resolved', 'closed')) {
        orgs.push(p.organization_id);
        types.push(p.type);
      }
    }
    if (orgs.length === 0) return [];

    const { rows } = await sql.query(
      `SELECT id, organization_id FROM tickets
        WHERE status = 'resolved' AND resolved_at < $1
          AND (organization_id, type) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))
        ORDER BY resolved_at
        LIMIT ${CLOSE_BATCH}`,
      [cutoff.toISOString(), orgs, types],
    );
    return rows as Array<{ id: string; organization_id: string }>;
  });

  for (const c of candidates) {
    // One transaction per ticket, so a failure rolls back that ticket alone.
    try {
      const didClose = await withSystemContext(async (sql: Sql) => {
        await sql.query('BEGIN');
        try {
          // Re-check under the row lock. Between the candidate query and here the ticket may
          // have been reopened and resolved again (still 'resolved', but the clock restarted),
          // or another instance may hold it — SKIP LOCKED passes over it rather than waiting.
          // organization_id in the predicate: the system context bypasses RLS.
          const { rows } = await sql.query(
            `SELECT status, resolved_at FROM tickets
              WHERE id = $1 AND organization_id = $2
              FOR UPDATE SKIP LOCKED`,
            [c.id, c.organization_id],
          );
          if (!rows[0] || !isDueForAutoClose(rows[0], cutoff)) {
            await sql.query('ROLLBACK');
            return false;
          }
          await applyTransition(sql, null, c.id, 'closed');
          await sql.query('COMMIT');
          return true;
        } catch (err) {
          await sql.query('ROLLBACK');
          throw err;
        }
      });
      if (didClose) closed += 1; else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, ticketId: c.id }, 'auto-close of a resolved ticket failed');
    }
  }

  return { closed, skipped, failed };
}

/**
 * Starts the sweep loop. Hourly: a day-granular window needs nothing tighter, and a ticket closing
 * up to an hour after its seventh day is not a difference anyone can see.
 *
 * A throw inside a tick must never take the process down.
 */
export function startAutoCloseResolvedSweeper(days: number, intervalMs = HOUR_MS): NodeJS.Timeout {
  const tick = async () => {
    try {
      const out = await sweepAutoCloseResolved(new Date(), days);
      if (out.closed > 0 || out.failed > 0) {
        logger.info({ ...out, days }, 'auto-close of resolved tickets completed');
      }
    } catch (err) {
      logger.error({ err }, 'auto-close sweep tick failed');
    }
  };
  // First sweep a minute after boot, then on interval.
  setTimeout(tick, 60_000);
  return setInterval(tick, intervalMs);
}
