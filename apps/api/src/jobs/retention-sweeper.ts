// Daily retention sweep.
//
// DETECTION, NOT ENFORCEMENT. Nexus never deletes Entra accounts and cannot stop the Azure
// portal, so this exists to NOTICE: an account that vanished before its retention date is a
// compliance breach, and one that reaches its date needs a human decision.
//
// NOTHING HERE DELETES ANYTHING — not an account, not a hold. Expiry raises a ticket. A cron job
// destroying seven-year federal records unattended is not supervisable, and the failure would
// surface years later through an auditor rather than through the system.
//
// Spec: docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md
import { withSystemContext, type Sql } from '../db/pool.js';
import { logger } from '../logger.js';
import { getProvisioningGraph } from '../integrations/m365/provisioning-runtime.js';
import { accountExists } from '../integrations/m365/provisioning-graph.js';
import { nextTicketNumber } from '../modules/tickets.js';
import { decideHold } from '../modules/retention/sweep-decision.js';

/** Bounded so one sweep cannot exhaust the Graph throttling budget on a large backlog. */
const SWEEP_BATCH = 500;

interface HoldRow {
  id: string;
  organization_id: string;
  upn: string;
  entra_object_id: string;
  display_name_at_offboard: string | null;
  retention_class: string;
  retain_until: string | Date;
  offboarded_at: string | Date;
}

export async function sweepRetentionHolds(now: Date = new Date()): Promise<{
  checked: number; breached: number; eligible: number; disposed: number; unchecked: number;
}> {
  let checked = 0; let breached = 0; let eligible = 0; let disposed = 0; let unchecked = 0;

  // Only 'active' holds. A hold already breached or eligible has raised its ticket; revisiting it
  // would raise the same one every day until someone worked it.
  const holds = await withSystemContext(async (sql: Sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, upn, entra_object_id, display_name_at_offboard,
              retention_class, retain_until, offboarded_at
         FROM retention_holds
        WHERE state = 'active'
        ORDER BY retain_until
        LIMIT ${SWEEP_BATCH}`,
    );
    return rows as HoldRow[];
  });

  // No holds, no tenant round trip.
  if (holds.length === 0) return { checked, breached, eligible, disposed, unchecked };

  const g = await getProvisioningGraph();

  for (const hold of holds) {
    const present = await accountExists(g.graph, hold.entra_object_id);
    const outcome = decideHold(hold, present, now);
    checked += 1;

    switch (outcome.action) {
      case 'none':
        // Deliberately not even a last_checked_at stamp — see decideHold. An unsuccessful check
        // must not be recorded as a successful one.
        unchecked += 1;
        break;

      case 'touch':
        await setState(hold, null, now);
        break;

      case 'breach':
        breached += 1;
        await raiseTicket(hold, 'breach');
        await setState(hold, 'breached', now);
        logger.error(
          { holdId: hold.id, upn: hold.upn, retainUntil: hold.retain_until, class: hold.retention_class },
          'RETENTION BREACH: a retained account no longer exists in the tenant',
        );
        break;

      case 'eligible':
        eligible += 1;
        await raiseTicket(hold, 'eligible');
        await setState(hold, 'eligible', now);
        break;

      case 'disposed':
        // Gone after its date: someone did the right thing outside Nexus. Record it, no alarm.
        disposed += 1;
        await setState(hold, 'disposed', now);
        break;
    }
  }

  if (unchecked > 0) {
    // A retention system nobody notices has stopped is worse than none, because it is trusted.
    logger.warn({ unchecked, checked }, 'retention sweep could not check some holds');
  }
  return { checked, breached, eligible, disposed, unchecked };
}

/** `state === null` means "only stamp last_checked_at" — the healthy, uneventful case. */
async function setState(hold: HoldRow, state: string | null, now: Date): Promise<void> {
  await withSystemContext(async (sql: Sql) => {
    if (state === null) {
      await sql.query(
        `UPDATE retention_holds SET last_checked_at = $2, updated_at = now()
          WHERE id = $1 AND organization_id = $3`,
        [hold.id, now.toISOString(), hold.organization_id],
      );
      return;
    }
    await sql.query(
      `UPDATE retention_holds SET state = $2, last_checked_at = $3, updated_at = now()
        WHERE id = $1 AND organization_id = $4`,
      [hold.id, state, now.toISOString(), hold.organization_id],
    );
  });
}

/**
 * A ticket, not a notification: a notification is a thing to miss, a ticket is a thing to work,
 * and it inherits the SLA and audit machinery that already exists.
 *
 * Inserted directly rather than through createTicket() because a background job has no acting
 * principal — the same pattern as modules/posture.ts and integrations/m365/ingest.ts.
 */
async function raiseTicket(hold: HoldRow, kind: 'breach' | 'eligible'): Promise<void> {
  // pg returns timestamptz as a Date, and String(date).slice(0,10) yields "Wed Sep 02" — a
  // date nobody can reconcile against a record. Normalise through toISOString().
  const isoDay = (v: string | Date) => new Date(v).toISOString().slice(0, 10);
  const until = isoDay(hold.retain_until);
  const offboarded = isoDay(hold.offboarded_at);

  const subject = kind === 'breach'
    ? `Retention breach: ${hold.upn} was deleted before ${until}`
    : `Retention expired: review and dispose ${hold.upn}`;

  const description = kind === 'breach'
    ? `The account ${hold.upn} (${hold.display_name_at_offboard ?? 'name not recorded'}) was `
      + `offboarded on ${offboarded} and classified ${hold.retention_class}, so it had to be `
      + `retained until ${until}. It no longer exists in the tenant. Determine who removed it `
      + `and when, and record the outcome.`
    : `The account ${hold.upn} was offboarded on ${offboarded} and classified `
      + `${hold.retention_class}. Its retention obligation ended on ${until}. Review and decide `
      + `disposition. Nothing has been deleted automatically.`;

  await withSystemContext(async (sql: Sql) => {
    // EXPLICIT TRANSACTION, and it is load-bearing. nextTicketNumber takes
    // pg_advisory_xact_lock, which is released the moment its transaction ends — and
    // withSystemContext opens no transaction of its own. Without this BEGIN the lock is dropped
    // before the INSERT, reintroducing the duplicate ticket-number race that 708b7ff fixed in
    // ingest.ts by adding exactly this.
    await sql.query('BEGIN');
    try {
      const number = await nextTicketNumber(sql, hold.organization_id);
      await sql.query(
        `INSERT INTO tickets
           (organization_id, ticket_number, type, category, source_channel, subject, description,
            priority, status)
         VALUES ($1,$2,'service_request','security.retention_review','system',$3,$4,$5,'triage')`,
        [hold.organization_id, number, subject, description, kind === 'breach' ? 'P2' : 'P3'],
      );
      await sql.query('COMMIT');
    } catch (err) {
      await sql.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Daily. A one-to-seven-year window needs no finer resolution, and each tick is one Graph read
 * per active hold.
 *
 * A throw inside a tick must never take the process down.
 */
export function startRetentionSweeper(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const out = await sweepRetentionHolds(new Date());
      if (out.checked > 0) logger.info(out, 'retention sweep completed');
    } catch (err) {
      logger.error({ err }, 'retention sweep tick failed');
    }
  };
  // PRIME an early first run. setInterval alone means the first sweep is a full day after boot
  // AND the timer restarts on every deploy — on a frequently redeployed API the daily sweep may
  // never fire at all, while looking scheduled. retention-purge.ts and sla-sweeper.ts both prime
  // for the same reason. A minute's delay keeps it clear of the boot storm.
  setTimeout(tick, 60_000).unref?.();
  return setInterval(tick, intervalMs);
}
