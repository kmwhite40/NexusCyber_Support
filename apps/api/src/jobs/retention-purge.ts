// Data-retention purge. Permanently deletes resolved incidents, resolved/closed
// problems, and closed/rejected changes once they are older than the retention window
// (config.retention.days, default 30). Runs daily. Deletions are hard and irreversible;
// cascade handles most child rows, and the few non-cascade ticket references are nulled
// first (posture_findings.linked_ticket_id, alerts.escalated_ticket_id, oncall_pages.ticket_id).
import { withSystemContext } from '../db/pool.js';
import { audit } from '../modules/audit.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** PII is retained only for the duration of fulfillment: once the ticket reaches a terminal
 *  status the captured values are deleted, leaving the audit trail as the only record that
 *  they ever existed. */
export function sensitivePurgeSql(): string {
  return `DELETE FROM ticket_sensitive_fields
          WHERE ticket_id IN (
            SELECT id FROM tickets WHERE status IN ('resolved','closed')
          )
          RETURNING organization_id, ticket_id`;
}

/** Pure: the tombstone audit records for one PII sweep — one per (organization, ticket),
 *  carrying the COUNT of destroyed values and never a key or a value. The spec requires the
 *  destruction of PII to leave a record in the hash-chained audit log; the deleted rows are
 *  by then the only evidence it ever existed, so the count and the ticket are all that can
 *  legitimately be kept. */
export function piiPurgeTombstones(
  deleted: Array<{ organization_id: string; ticket_id: string }>,
): Array<{ organizationId: string; ticketId: string; values: number }> {
  const byTicket = new Map<string, { organizationId: string; ticketId: string; values: number }>();
  for (const row of deleted) {
    const existing = byTicket.get(row.ticket_id);
    if (existing) existing.values += 1;
    else byTicket.set(row.ticket_id, { organizationId: row.organization_id, ticketId: row.ticket_id, values: 1 });
  }
  return [...byTicket.values()];
}

export function startRetentionPurge(intervalMs = DAY_MS): NodeJS.Timeout {
  const days = config.retention.days;

  const tick = async () => {
    try {
      const purgedPii = await withSystemContext(async (sql) => {
        await sql.query('BEGIN');
        try {
          const cutoff = `(now() - ($1 || ' days')::interval)`;
          // PII first: it must be purged (and tombstoned) before the ticket delete below,
          // whose ON DELETE CASCADE would otherwise destroy the same rows unrecorded.
          const pii = await sql.query(sensitivePurgeSql());
          if (pii.rowCount) logger.info({ purged: pii.rowCount }, 'purged ticket PII');

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
          return piiPurgeTombstones(pii.rows as Array<{ organization_id: string; ticket_id: string }>);
        } catch (e) {
          await sql.query('ROLLBACK');
          throw e;
        }
      });

      // Tombstones are written AFTER the purge transaction commits — the audit row must
      // attest to a destruction that actually happened, and audit() runs its own
      // transaction (on its own connection) around the chain's advisory lock.
      for (const t of purgedPii) {
        await audit(null, {
          action: 'pii.purged',
          organizationId: t.organizationId,
          resourceType: 'ticket',
          resourceId: t.ticketId,
          detail: { values_destroyed: t.values, reason: 'ticket reached a terminal status' },
        });
      }
    } catch (err) {
      logger.error({ err }, 'retention purge tick failed');
    }
  };

  // First sweep a minute after boot, then daily.
  setTimeout(tick, 60_000);
  return setInterval(tick, intervalMs);
}
