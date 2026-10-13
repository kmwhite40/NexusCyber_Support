import { describe, it, expect } from 'vitest';
import { stampSlaAndTriage } from '../src/modules/tickets.js';

/** Minimal fake of the `Sql` surface: records every statement so a test can assert on what
 *  was NOT written. `business_calendars` returning no rows makes loadCalendar fall back to
 *  its 8x5 defaults, which is all we need. */
function fakeSql() {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
}

const ticket = { id: 't-1', organization_id: 'o-1', priority: 'P2' };

describe('stampSlaAndTriage', () => {
  it('starts both clocks by default', async () => {
    const sql = fakeSql();
    const due = await stampSlaAndTriage(sql as never, ticket);
    expect(sql.queries.filter((q) => /INSERT INTO sla_instances/i.test(q))).toHaveLength(2);
    expect(due.response_due_at).not.toBeNull();
    expect(due.resolution_due_at).not.toBeNull();
  });

  it('writes no sla_instances rows when suppressed', async () => {
    const sql = fakeSql();
    const due = await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /INSERT INTO sla_instances/i.test(q))).toBe(false);
    expect(due.response_due_at).toBeNull();
    expect(due.resolution_due_at).toBeNull();
  });

  it('still moves a suppressed ticket to triage', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /UPDATE tickets SET status='triage'/i.test(q))).toBe(true);
  });

  it('does not stamp due dates when suppressed', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /response_due_at/i.test(q))).toBe(false);
  });
});
