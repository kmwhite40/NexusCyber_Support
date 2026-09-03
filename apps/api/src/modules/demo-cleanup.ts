// The SQL for standing down seeded demo identities in an environment that should not have them.
//
// NOT a migration, deliberately. Migrations run in EVERY environment, and local/demo databases
// create these accounts on purpose — SEED_DEMO exists for exactly that. A migration would fight
// the seed it is meant to coexist with, and would re-fight it on every fresh install.
// This is an operator action against a specific database: see scripts/disable-demo-accounts.mjs.
//
// They are stood down, NOT deleted. These accounts are the recorded author of 36 KB pages,
// 5 KB spaces, 4 queues, 3 escalation policies and 2 automation rules, every one of them
// ON DELETE NO ACTION. Deleting them would mean reassigning authorship of live content to
// somebody who did not write it — falsifying provenance to tidy a user list. The access is the
// risk; the rows are the record.

/** Identity domains that only ever belong to seeded demo data. */
export const DEMO_EMAIL_PREDICATE = `(
  email::text LIKE '%@demo.example.com'
  OR email::text LIKE '%@nexus.example.com'
  OR email::text LIKE '%@anchor.example'
)`;

/** What would change, so an operator can read it before anything is written. */
export const SELECT_AFFECTED = `
  SELECT u.email::text AS email,
         u.status,
         (SELECT count(*)::int FROM role_assignments ra WHERE ra.user_id = u.id) AS roles
    FROM users u
   WHERE ${DEMO_EMAIL_PREDICATE.replace(/email::text/g, 'u.email::text')}
   ORDER BY u.email`;

/**
 * Order matters: roles first, then status.
 *
 * A role assignment is what a permission audit reads and what put two of these accounts on a
 * real CAB announcement recipient list — so it is the part that must not survive a partial
 * failure. Status is now genuinely enforced in the auth path (loadPrincipal), but it was not
 * until today, and belt-and-braces is cheap here.
 */
export const DELETE_ROLE_ASSIGNMENTS = `
  DELETE FROM role_assignments
   WHERE user_id IN (SELECT id FROM users WHERE ${DEMO_EMAIL_PREDICATE})`;

export const SUSPEND_ACCOUNTS = `
  UPDATE users SET status = 'suspended', updated_at = now()
   WHERE ${DEMO_EMAIL_PREDICATE} AND status <> 'suspended'`;
