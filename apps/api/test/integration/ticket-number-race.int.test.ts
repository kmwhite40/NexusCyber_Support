import { it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { describeDb } from '../helpers/db.js';
import { withSystemContext, type Sql } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createRequest } from '../../src/modules/catalog.js';
import { ingestMessage, type InboundMessage } from '../../src/integrations/m365/ingest.js';
import type { Principal } from '../../src/types.js';

// Reproduces the ticket-number-allocation race: `nextTicketNumber` (modules/tickets.ts)
// does `COALESCE(MAX(...),0)+1` under a per-org pg_advisory_xact_lock so concurrent
// creates for the same org don't both read the same MAX and collide on
// tickets_organization_id_ticket_number_key. Two call sites — the service-catalog
// request path (catalog.ts) and mail-to-ticket ingest (integrations/m365/ingest.ts,
// LIVE against a shared mailbox) — used to run the same unlocked query directly instead
// of calling the shared, locked helper. This suite fires many concurrent ticket
// creations at ONE organization through each of those paths and asserts every allocated
// number is unique with no unique-violation escaping to the caller.
//
// Red-then-green: with either call site's use of nextTicketNumber reverted to its old
// unlocked inline query (or, for the ingest path, with the explicit BEGIN/COMMIT wrapper
// removed so the advisory lock has no transaction to live in), this test fails — see the
// task report for the actual failing run.
//
// A third test below covers a related fix in the same transaction boundary: the ingest
// dedupe marker (integration_state) now commits atomically with the ticket instead of
// after it, so a mid-transaction failure can't leave a committed ticket with no marker.
/**
 * Wraps a real client so the one statement that writes the ingest dedupe marker
 * (`INSERT INTO integration_state ...`, from ingest.ts's `setState`) fails, while every
 * other statement — including BEGIN/COMMIT/ROLLBACK and the ticket INSERT — passes
 * through untouched. Used to prove the dedupe marker now commits atomically with the
 * ticket: fail it, and the ticket insert (already run, uncommitted, earlier in the same
 * transaction) must roll back with it.
 */
function withFaultyDedupeWrite(sql: Sql): Sql {
  const faulty = {
    query: (text: unknown, params?: unknown[]) => {
      if (typeof text === 'string' && text.includes('INSERT INTO integration_state')) {
        return Promise.reject(new Error('simulated dedupe-marker write failure'));
      }
      return params === undefined ? sql.query(text as string) : sql.query(text as string, params);
    },
  };
  return faulty as unknown as Sql;
}

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const CONCURRENCY = 16;

describeDb('ticket number allocation under concurrency (integration)', () => {
  let customer: Principal;
  let orgId: string;

  beforeAll(async () => {
    customer = await principalByEmail('user@demo.example.com');
    orgId = (
      await withSystemContext(async (sql) =>
        (
          await sql.query("SELECT organization_id FROM organization_domains WHERE domain='demo.example.com'")
        ).rows[0],
      )
    ).organization_id;
  });

  it('assigns unique ticket numbers under concurrent service-catalog requests', async () => {
    // 'device.enrollment': no request form and no approval gate, so this isolates the
    // number-allocation race from unrelated concurrency (form validation, approval-step
    // inserts) — every concurrent call takes the exact same code path to the same INSERT.
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createRequest(customer, 'device.enrollment', {})),
    );
    const numbers = results.map((r) => r.ticket_number as string);
    expect(numbers).toHaveLength(CONCURRENCY);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
  });

  it('assigns unique ticket numbers under concurrent mail-ingest creations', async () => {
    // Each call opens its OWN withSystemContext (own pooled connection) so this matches
    // the real production race: a poll tick and a concurrent webhook delivery (or two
    // overlapping poll ticks) each calling ingestMessage on a different connection for
    // the same org, per the module comment ("subscription-ready: a webhook can call the
    // same ingestMessage").
    const runId = randomUUID();
    const messages: InboundMessage[] = Array.from({ length: CONCURRENCY }, (_, i) => ({
      id: `race-${runId}-${i}`,
      internetMessageId: `race-${runId}-${i}`,
      fromAddress: 'race-tester@demo.example.com',
      fromName: 'Race Tester',
      subject: `Race test ${runId} #${i}`,
      bodyPreview: 'concurrency probe',
    }));

    const results = await Promise.all(messages.map((m) => withSystemContext((sql) => ingestMessage(sql, m))));
    expect(results.every((r) => r.created === true)).toBe(true);

    const { rows } = await withSystemContext((sql) =>
      sql.query('SELECT ticket_number FROM tickets WHERE organization_id=$1 AND subject LIKE $2', [
        orgId,
        `Race test ${runId}%`,
      ]),
    );
    expect(rows).toHaveLength(CONCURRENCY);
    expect(new Set(rows.map((r: { ticket_number: string }) => r.ticket_number)).size).toBe(CONCURRENCY);
  });

  it('rolls back the ticket insert if the dedupe-marker write fails (atomicity)', async () => {
    // Before this fix, setState(seenKey) ran AFTER COMMIT: a failure writing the dedupe
    // marker would leave an already-committed ticket behind with no marker, so the next
    // poll would re-ingest the same email as a second, duplicate ticket. Injecting a
    // failure into just that one statement, mid-transaction, proves the ticket insert now
    // shares its fate with the dedupe write instead of surviving it.
    const internetMessageId = `atomic-${randomUUID()}`;
    const msg: InboundMessage = {
      id: internetMessageId,
      internetMessageId,
      fromAddress: 'race-tester@demo.example.com',
      fromName: 'Atomic Tester',
      subject: `Atomicity probe ${internetMessageId}`,
      bodyPreview: 'atomicity probe',
    };

    await expect(
      withSystemContext((sql) => ingestMessage(withFaultyDedupeWrite(sql), msg)),
    ).rejects.toThrow('simulated dedupe-marker write failure');

    const { rows } = await withSystemContext((sql) =>
      sql.query('SELECT id FROM tickets WHERE organization_id=$1 AND subject=$2', [orgId, msg.subject]),
    );
    expect(rows).toHaveLength(0); // ticket insert was rolled back along with the failed dedupe write
  });
});
