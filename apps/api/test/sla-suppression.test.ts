import { describe, it, expect } from 'vitest';
import { stampSlaAndTriage } from '../src/modules/tickets.js';

/** Minimal fake of the `Sql` surface: records every statement so a test can assert on what
 *  was NOT written. `business_calendars` returning no rows makes loadCalendar fall back to
 *  its 8x5 defaults, which is all we need. */
function fakeSql() {
  const queries: string[] = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    queries,
    calls,
    // Record parameters, not just statement text. An earlier version matched on the literal
    // `status='triage'` and broke the moment the status became a bind parameter — a test
    // failing for a change that altered no behaviour at all.
    query: async (text: string, params: unknown[] = []) => {
      queries.push(text);
      calls.push({ text, params });
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
    const update = sql.calls.find((c) => /UPDATE tickets SET status=/i.test(c.text));
    expect(update).toBeTruthy();
    expect(update?.params).toContain('triage');
  });

  it('honours an explicit initial status, so a blocked import does not land as triage', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true, 'blocked');
    const update = sql.calls.find((c) => /UPDATE tickets SET status=/i.test(c.text));
    expect(update?.params).toContain('blocked');
    expect(update?.params).not.toContain('triage');
  });

  it('does not stamp due dates when suppressed', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /response_due_at/i.test(q))).toBe(false);
  });
});
