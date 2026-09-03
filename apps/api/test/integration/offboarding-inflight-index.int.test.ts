import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// Migration 0057 documents why a conditional INSERT is not enough on its own: under READ
// COMMITTED two concurrent requests can BOTH evaluate NOT EXISTS before either commits, so the
// application guard is statistical and the unique index is structural.
//
// The offboarding arming guard copied layer 1 and not layer 2. Its index predicate was
// ('running','awaiting_cloudpc'), which does not include 'scheduled' — so two concurrent
// schedules both inserted. The next sweep then claimed both rows into 'running' in ONE update,
// violating the index, aborting the batch, and throwing on every subsequent tick: no offboarding
// would fire at all until someone fixed the rows by hand.
describeDb('one in-flight offboarding run per ticket', () => {
  it('covers scheduled as well as running', async () => {
    const def = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'provisioning_runs_one_inflight_per_ticket'`,
      )).rows[0]?.def as string | undefined);
    expect(def).toBeDefined();
    expect(def).toContain('scheduled');
    expect(def).toContain('running');
  });

  it('actually refuses a second scheduled run for one ticket', async () => {
    // The structural half, exercised rather than assumed.
    const { ticketId, orgId } = await withSystemContext(async (sql) => {
      const org = (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id;
      const t = (await sql.query(
        `INSERT INTO tickets (organization_id, ticket_number, type, subject, status)
         VALUES ($1, 'IDX-'||floor(random()*1000000)::text, 'service_request', 'index probe', 'triage')
         RETURNING id`, [org])).rows[0].id;
      return { ticketId: t, orgId: org };
    });

    const arm = () => withSystemContext(async (sql) => sql.query(
      `INSERT INTO provisioning_runs (ticket_id, organization_id, kind, status, scheduled_for, plan)
       VALUES ($1,$2,'offboarding','scheduled', now() + interval '1 day', '{}'::jsonb)`,
      [ticketId, orgId],
    ));

    try {
      await arm();
      await expect(arm()).rejects.toThrow();   // the index, not the application, refuses this
    } finally {
      // ALWAYS clean up. A failed assertion here used to leave duplicate in-flight rows behind,
      // which then made the very migration under test fail on the next run — and with
      // RUN_MIGRATIONS_ON_BOOT that is a service that will not start.
      await withSystemContext(async (sql) => {
        await sql.query('DELETE FROM provisioning_runs WHERE ticket_id=$1', [ticketId]);
        await sql.query('DELETE FROM tickets WHERE id=$1', [ticketId]);
      });
    }
  });
});
