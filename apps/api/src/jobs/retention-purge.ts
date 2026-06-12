// Data-retention purge. Permanently deletes resolved incidents, resolved/closed
// problems, and closed/rejected changes once they are older than the retention window
// (config.retention.days, default 30). Runs daily. Deletions are hard and irreversible;
// cascade handles most child rows, and the few non-cascade ticket references are nulled
// first (posture_findings.linked_ticket_id, alerts.escalated_ticket_id, oncall_pages.ticket_id).
import { withSystemContext } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function startRetentionPurge(intervalMs = DAY_MS): NodeJS.Timeout {
  const days = config.retention.days;

  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        await sql.query('BEGIN');
        try {
          const cutoff = `(now() - ($1 || ' days')::interval)`;
          // Incident tickets that resolved/closed before the cutoff.
          const expiring = `SELECT id FROM tickets
             WHERE type = 'incident' AND status IN ('resolved','closed')
               AND COALESCE(closed_at, resolved_at) IS NOT NULL
               AND COALESCE(closed_at, resolved_at) < ${cutoff}`;
          // Null the non-cascade references that would otherwise block the delete.
          await sql.query(`UPDATE posture_findings SET linked_ticket_id = NULL WHERE linked_ticket_id IN (${expiring})`, [days]);
          await sql.query(`UPDATE alerts SET escalated_ticket_id = NULL WHERE escalated_ticket_id IN (${expiring})`, [days]);
          await sql.query(`UPDATE oncall_pages SET ticket_id = NULL WHERE ticket_id IN (${expiring})`, [days]);
          const inc = await sql.query(`DELETE FROM tickets WHERE id IN (${expiring})`, [days]);

          const prob = await sql.query(
            `DELETE FROM problems WHERE status IN ('resolved','closed')
               AND COALESCE(resolved_at, updated_at) < ${cutoff}`,
            [days],
          );
          const chg = await sql.query(
            `DELETE FROM changes WHERE status IN ('closed','rejected') AND updated_at < ${cutoff}`,
            [days],
          );

          await sql.query('COMMIT');
          const total = (inc.rowCount ?? 0) + (prob.rowCount ?? 0) + (chg.rowCount ?? 0);
          if (total > 0) {
            logger.info(
              { incidents: inc.rowCount, problems: prob.rowCount, changes: chg.rowCount, retentionDays: days },
              'retention purge complete',
            );
          }
        } catch (e) {
          await sql.query('ROLLBACK');
          throw e;
        }
      });
    } catch (err) {
      logger.error({ err }, 'retention purge tick failed');
    }
  };

  // First sweep a minute after boot, then daily.
  setTimeout(tick, 60_000);
  return setInterval(tick, intervalMs);
}
