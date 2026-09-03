// Stand down seeded demo identities in an environment that should not have them.
//
// DRY RUN BY DEFAULT. Pass --apply to write. Run it against ONE database deliberately; this is
// not a migration, because migrations run everywhere and local/demo databases create these
// accounts on purpose (SEED_DEMO). See apps/api/src/modules/demo-cleanup.ts for the reasoning.
//
// What it does:  removes their role assignments, then sets status='suspended'.
// What it never does:  delete a user, an organization, or any content.
//
// These accounts are the recorded author of 36 KB pages, 5 KB spaces, 4 queues, 3 escalation
// policies and 2 automation rules, all ON DELETE NO ACTION. Deleting them would mean reassigning
// authorship of live content to somebody who did not write it. The access is the risk; the rows
// are the record.
//
//   DB_URL=... npx tsx scripts/disable-demo-accounts.mjs           # show what would change
//   DB_URL=... npx tsx scripts/disable-demo-accounts.mjs --apply   # do it
// Run with tsx so the statements come from the TESTED source, not a dist build that can be
// stale or absent:
//   DB_URL=... npx tsx scripts/disable-demo-accounts.mjs [--apply]
import pg from 'pg';
import {
  SELECT_AFFECTED, DELETE_ROLE_ASSIGNMENTS, SUSPEND_ACCOUNTS,
} from '../apps/api/src/modules/demo-cleanup.ts';

const APPLY = process.argv.includes('--apply');
const url = process.env.DB_URL;
if (!url) { console.error('DB_URL not set'); process.exit(1); }

// Managed Postgres requires TLS; a local docker instance does not speak it at all. Infer from
// the target rather than making the operator remember a flag.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const c = new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
await c.connect();

const before = await c.query(SELECT_AFFECTED);
console.log(`=== demo identities found: ${before.rows.length} ===`);
for (const r of before.rows) {
  console.log(`  ${r.email.padEnd(34)} status=${String(r.status).padEnd(10)} roles=${r.roles}`);
}
const active = before.rows.filter((r) => r.status === 'active').length;
const roles = before.rows.reduce((n, r) => n + r.roles, 0);
console.log(`\n  active: ${active}   role assignments: ${roles}`);

if (before.rows.length === 0) { console.log('\nNothing to do.'); await c.end(); process.exit(0); }

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to:');
  console.log(`  - delete ${roles} role assignment(s)`);
  console.log(`  - suspend ${active} account(s)`);
  console.log('\nNo user, organization or content row is deleted by this script.');
  await c.end();
  process.exit(0);
}

// One transaction: half-applied is the worst outcome — an account with no roles but still
// active, or suspended but still carrying a role a permission audit would report.
await c.query('BEGIN');
try {
  const d = await c.query(DELETE_ROLE_ASSIGNMENTS);
  const s = await c.query(SUSPEND_ACCOUNTS);
  await c.query('COMMIT');
  console.log(`\n✓ removed ${d.rowCount} role assignment(s), suspended ${s.rowCount} account(s).`);
  console.log('  Accounts and their authorship are intact.');
} catch (err) {
  await c.query('ROLLBACK');
  console.error('\n✗ rolled back:', err.message);
  process.exit(1);
}

const after = await c.query(SELECT_AFFECTED);
console.log('\n=== after ===');
for (const r of after.rows) console.log(`  ${r.email.padEnd(34)} status=${String(r.status).padEnd(10)} roles=${r.roles}`);
await c.end();
