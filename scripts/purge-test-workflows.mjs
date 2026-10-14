#!/usr/bin/env node
/**
 * Remove the `wf_test_*` workflows and tickets that test/integration/workflows.int.test.ts
 * leaked before it learned to clean up after itself (one workflow + one ticket per run).
 *
 * DRY RUN BY DEFAULT. Pass --apply to actually delete.
 *
 *   node scripts/purge-test-workflows.mjs            # report only
 *   node scripts/purge-test-workflows.mjs --apply    # delete, in one transaction
 *
 * Requires DATABASE_URL (the OWNER role — APP_DATABASE_URL is RLS-restricted and will appear
 * to find nothing). Back up first: scripts/db-backup.sh
 *
 * Safety properties, in order of how much they matter:
 *   - Only ever matches the literal prefix `wf_test_`, which no real ticket type uses.
 *   - Refuses to delete if anything with a NO ACTION foreign key (alerts, on-call pages,
 *     posture findings) still points at a matched ticket — those would block mid-delete.
 *   - Prints the target host and the exact counts, and requires --apply to change anything.
 *   - One transaction: it all lands or none of it does.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const PATTERN = 'wf_test_%';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ DATABASE_URL is not set. Load the root .env first:  set -a; . ./.env; set +a');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];

await client.connect();
try {
  console.log(`▶ target: ${new URL(url).host}${new URL(url).pathname}`);
  console.log(`▶ mode:   ${APPLY ? 'APPLY (will delete)' : 'dry run (no changes)'}\n`);

  const counts = await one(
    `SELECT
       (SELECT count(*)::int FROM workflows WHERE ticket_type LIKE $1) AS workflows,
       (SELECT count(*)::int FROM workflow_transitions t
          JOIN workflows w ON w.id = t.workflow_id WHERE w.ticket_type LIKE $1) AS transitions,
       (SELECT count(*)::int FROM tickets WHERE type LIKE $1) AS tickets,
       (SELECT count(*)::int FROM sla_instances s
          JOIN tickets t ON t.id = s.ticket_id WHERE t.type LIKE $1) AS sla_instances,
       (SELECT count(*)::int FROM ticket_events e
          JOIN tickets t ON t.id = e.ticket_id WHERE t.type LIKE $1) AS ticket_events`,
    [PATTERN],
  );
  console.table(counts);

  // Anything referencing a matched ticket WITHOUT a cascade would abort the delete halfway.
  const blockers = await one(
    `SELECT
       (SELECT count(*)::int FROM alerts WHERE escalated_ticket_id IN (SELECT id FROM tickets WHERE type LIKE $1)) AS alerts,
       (SELECT count(*)::int FROM oncall_pages WHERE ticket_id IN (SELECT id FROM tickets WHERE type LIKE $1)) AS oncall_pages,
       (SELECT count(*)::int FROM posture_findings WHERE linked_ticket_id IN (SELECT id FROM tickets WHERE type LIKE $1)) AS posture_findings`,
    [PATTERN],
  );
  const blocking = Object.values(blockers).reduce((a, b) => a + b, 0);
  if (blocking > 0) {
    console.error('✗ refusing: real records still reference these tickets —', blockers);
    console.error('  Those are not test artifacts. Investigate before deleting anything.');
    process.exit(1);
  }
  console.log('✓ no alerts, on-call pages or posture findings reference them\n');

  if (counts.workflows === 0 && counts.tickets === 0) {
    console.log('Nothing to do — already clean.');
    process.exit(0);
  }
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to delete (back up first: scripts/db-backup.sh).');
    process.exit(0);
  }

  await client.query('BEGIN');
  const wf = await client.query('DELETE FROM workflows WHERE ticket_type LIKE $1', [PATTERN]);
  const tk = await client.query('DELETE FROM tickets WHERE type LIKE $1', [PATTERN]);
  await client.query('COMMIT');

  const after = await one(
    `SELECT
       (SELECT count(*)::int FROM workflows WHERE ticket_type LIKE $1) AS workflows_left,
       (SELECT count(*)::int FROM tickets WHERE type LIKE $1) AS tickets_left,
       (SELECT count(*)::int FROM sla_instances s LEFT JOIN tickets t ON t.id = s.ticket_id
         WHERE t.id IS NULL) AS orphaned_sla_rows`,
    [PATTERN],
  );
  console.log(`✓ deleted ${wf.rowCount} workflows and ${tk.rowCount} tickets (cascades took their children)`);
  console.table(after);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✗ failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
