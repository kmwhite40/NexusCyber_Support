import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// An org stored as " Strategic Business Systems (Federal)" (leading space, untrimmed at signup)
// produced ticket numbers like " STR-000001". ticketNumberPrefix was fixed to strip
// non-alphanumerics before slicing, but that was a CODE fix — the rows already written kept the
// bad value, and they are not merely cosmetic:
//
// mail-ingest threading extracts "STR-000001" from a reply subject via a \b-anchored regex and
// looks it up with `ticket_number = $2`. Against a stored " STR-000001" that match FAILS, so a
// customer replying to one of those tickets silently opens a brand new one instead of threading.
//
// The constraint is what stops this class of defect coming back through some other write path.
describeDb('ticket number hygiene', () => {
  it('stores no ticket number with leading or trailing whitespace', async () => {
    const bad = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT ticket_number FROM tickets WHERE ticket_number <> btrim(ticket_number)`,
      )).rows.map((r: { ticket_number: string }) => r.ticket_number));
    expect(bad).toEqual([]);
  });

  it('refuses an untrimmed ticket number at the database level', async () => {
    const def = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'tickets'::regclass AND conname = 'tickets_ticket_number_trimmed'`,
      )).rows[0]?.def as string | undefined);
    expect(def).toBeDefined();
    expect(def).toContain('btrim');
  });

  it('stores no organization name with leading or trailing whitespace', async () => {
    // The root cause, not just the symptom: the prefix is derived from this name, and an
    // untrimmed name also displays wrong everywhere it is shown.
    const bad = await withSystemContext(async (sql) =>
      (await sql.query(`SELECT name FROM organizations WHERE name <> btrim(name)`))
        .rows.map((r: { name: string }) => r.name));
    expect(bad).toEqual([]);
  });
});
