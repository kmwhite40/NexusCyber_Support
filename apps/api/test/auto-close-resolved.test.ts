// Resolved tickets close themselves after AUTO_CLOSE_RESOLVED_DAYS.
//
// The close must be the SAME close a person makes — closed_at stamped, a status_changed event,
// an audit row, ticket.closed published — so the sweep goes through applyTransition rather than
// writing tickets itself, and it must respect each ticket's workflow: an org whose workflow does
// not allow resolved -> closed keeps its tickets in Resolved, however old.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ORG_A = '22222222-2222-2222-2222-222222222222';
const ORG_B = '33333333-3333-3333-3333-333333333333';

const h = vi.hoisted(() => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let dbRows: (text: string, params: unknown[]) => any[] = () => [];
  const sql = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rows: dbRows(text, params) };
    },
  };
  return {
    queries, sql,
    setDbRows: (fn: (text: string, params: unknown[]) => any[]) => { dbRows = fn; },
    withSystemContext: vi.fn(async (fn: any) => fn(sql)),
    applyTransition: vi.fn(async () => ({})),
    resolveTransitions: vi.fn(),
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, pool: {} }));
vi.mock('../src/modules/tickets.js', () => ({ applyTransition: h.applyTransition }));
vi.mock('../src/modules/workflows.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/workflows.js')>()),
  resolveTransitions: h.resolveTransitions,
}));

const { autoCloseCutoff, isDueForAutoClose, sweepAutoCloseResolved } =
  await import('../src/jobs/auto-close-resolved.js');
const { DEFAULT_TRANSITIONS } = await import('../src/modules/workflows.js');
const { parseAutoCloseResolvedDays } = await import('../src/config.js');

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe('parseAutoCloseResolvedDays', () => {
  it('defaults to 7 days', () => {
    expect(parseAutoCloseResolvedDays({})).toBe(7);
  });

  it('accepts a configured window', () => {
    expect(parseAutoCloseResolvedDays({ AUTO_CLOSE_RESOLVED_DAYS: '14' })).toBe(14);
  });

  it('treats 0 as disabled, not as "close immediately"', () => {
    expect(parseAutoCloseResolvedDays({ AUTO_CLOSE_RESOLVED_DAYS: '0' })).toBe(0);
  });

  it('falls back to the default on a garbage or negative value', () => {
    // NaN would make every comparison false (silently disabled); a negative window would put the
    // cutoff in the future and close tickets the moment they resolve.
    expect(parseAutoCloseResolvedDays({ AUTO_CLOSE_RESOLVED_DAYS: 'seven' })).toBe(7);
    expect(parseAutoCloseResolvedDays({ AUTO_CLOSE_RESOLVED_DAYS: '-3' })).toBe(7);
    expect(parseAutoCloseResolvedDays({ AUTO_CLOSE_RESOLVED_DAYS: '' })).toBe(7);
  });
});

describe('autoCloseCutoff', () => {
  it('is N days before now', () => {
    expect(autoCloseCutoff(NOW, 7)).toEqual(daysAgo(7));
  });

  it('is null when the feature is disabled', () => {
    expect(autoCloseCutoff(NOW, 0)).toBeNull();
  });
});

describe('isDueForAutoClose', () => {
  const cutoff = daysAgo(7);

  it('is due once resolved for longer than the window', () => {
    expect(isDueForAutoClose({ status: 'resolved', resolved_at: daysAgo(8) }, cutoff)).toBe(true);
  });

  it('is not due inside the window, nor at the exact cutoff instant', () => {
    expect(isDueForAutoClose({ status: 'resolved', resolved_at: daysAgo(6) }, cutoff)).toBe(false);
    expect(isDueForAutoClose({ status: 'resolved', resolved_at: daysAgo(7) }, cutoff)).toBe(false);
  });

  it('only ever closes a ticket that is still Resolved', () => {
    // A ticket reopened since the candidate query ran keeps its old stamp only until transition
    // clears it — the status is the authority.
    for (const status of ['reopened', 'in_progress', 'closed']) {
      expect(isDueForAutoClose({ status, resolved_at: daysAgo(30) }, cutoff)).toBe(false);
    }
  });

  it('is not due with no resolved_at', () => {
    expect(isDueForAutoClose({ status: 'resolved', resolved_at: null }, cutoff)).toBe(false);
  });

  it('accepts the ISO string form as well as a Date', () => {
    expect(isDueForAutoClose({ status: 'resolved', resolved_at: daysAgo(8).toISOString() }, cutoff)).toBe(true);
  });
});

describe('sweepAutoCloseResolved', () => {
  beforeEach(() => {
    h.queries.length = 0;
    h.withSystemContext.mockClear();
    h.applyTransition.mockReset().mockResolvedValue({});
    h.resolveTransitions.mockReset().mockResolvedValue(DEFAULT_TRANSITIONS);
  });

  /** Two orgs with stale Resolved tickets; each locked row re-reads as still due. */
  function standardDb(over: { lockRow?: (id: string) => any } = {}) {
    h.setDbRows((text, params) => {
      if (/SELECT DISTINCT organization_id, type/.test(text)) {
        return [
          { organization_id: ORG_A, type: 'incident' },
          { organization_id: ORG_B, type: 'service_request' },
        ];
      }
      if (/ORDER BY resolved_at/.test(text)) {
        const orgs = params[1] as string[];
        return [
          { id: 't-a', organization_id: ORG_A },
          { id: 't-b', organization_id: ORG_B },
        ].filter((r) => orgs.includes(r.organization_id));
      }
      if (/FOR UPDATE SKIP LOCKED/.test(text)) {
        const id = params[0] as string;
        return over.lockRow ? over.lockRow(id) : [{ status: 'resolved', resolved_at: daysAgo(10) }];
      }
      return [];
    });
  }

  it('does nothing at all when disabled', async () => {
    standardDb();
    expect(await sweepAutoCloseResolved(NOW, 0)).toEqual({ closed: 0, skipped: 0, failed: 0 });
    expect(h.withSystemContext).not.toHaveBeenCalled();
  });

  it('closes due tickets in every org through the normal transition path, as the system', async () => {
    standardDb();
    const out = await sweepAutoCloseResolved(NOW, 7);
    expect(out).toEqual({ closed: 2, skipped: 0, failed: 0 });
    // null actor = system: honest attribution in ticket_events and the audit chain.
    expect(h.applyTransition).toHaveBeenCalledWith(h.sql, null, 't-a', 'closed');
    expect(h.applyTransition).toHaveBeenCalledWith(h.sql, null, 't-b', 'closed');
    // The candidate query is bounded by the cutoff, not by now().
    const cand = h.queries.find((q) => /ORDER BY resolved_at/.test(q.text))!;
    expect(cand.params[0]).toBe(daysAgo(7).toISOString());
    expect(cand.text).toMatch(/LIMIT \d+/);
  });

  it('runs each close in its own transaction and commits it', async () => {
    standardDb();
    await sweepAutoCloseResolved(NOW, 7);
    const tx = h.queries.map((q) => q.text.trim()).filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t));
    expect(tx).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });

  it('leaves Resolved tickets alone in an org whose workflow does not allow resolved -> closed', async () => {
    standardDb();
    h.resolveTransitions.mockImplementation(async (_sql: unknown, orgId: string) =>
      orgId === ORG_B ? { ...DEFAULT_TRANSITIONS, resolved: ['reopened'] } : DEFAULT_TRANSITIONS);
    const out = await sweepAutoCloseResolved(NOW, 7);
    expect(out.closed).toBe(1);
    expect(h.applyTransition).toHaveBeenCalledTimes(1);
    expect(h.applyTransition).toHaveBeenCalledWith(h.sql, null, 't-a', 'closed');
    // Excluded in the candidate query itself, so a backlog of un-closable tickets can never
    // fill the batch and starve the closable ones behind it.
    const cand = h.queries.find((q) => /ORDER BY resolved_at/.test(q.text))!;
    expect(cand.params[1]).toEqual([ORG_A]);
    expect(cand.params[2]).toEqual(['incident']);
  });

  it('skips the candidate query entirely when no workflow allows the close', async () => {
    standardDb();
    h.resolveTransitions.mockResolvedValue({ resolved: ['reopened'] });
    expect(await sweepAutoCloseResolved(NOW, 7)).toEqual({ closed: 0, skipped: 0, failed: 0 });
    expect(h.queries.some((q) => /ORDER BY resolved_at/.test(q.text))).toBe(false);
  });

  it('re-checks under the row lock and skips a ticket reopened or re-resolved since selection', async () => {
    standardDb({
      lockRow: (id) => id === 't-a'
        // Reopened and resolved again yesterday: still 'resolved', but the clock restarted.
        ? [{ status: 'resolved', resolved_at: daysAgo(1) }]
        // Another sweeper holds it (SKIP LOCKED returns nothing).
        : [],
    });
    const out = await sweepAutoCloseResolved(NOW, 7);
    expect(out).toEqual({ closed: 0, skipped: 2, failed: 0 });
    expect(h.applyTransition).not.toHaveBeenCalled();
    const tx = h.queries.map((q) => q.text.trim()).filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t));
    expect(tx).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
  });

  it('scopes the row lock to the ticket org', async () => {
    standardDb();
    await sweepAutoCloseResolved(NOW, 7);
    const lock = h.queries.find((q) => /FOR UPDATE SKIP LOCKED/.test(q.text))!;
    expect(lock.text).toMatch(/organization_id = \$2/);
    expect(lock.params).toEqual(['t-a', ORG_A]);
  });

  it('one failing ticket rolls back alone and does not stop the rest', async () => {
    standardDb();
    h.applyTransition.mockImplementation(async (_s: unknown, _a: unknown, id: string) => {
      if (id === 't-a') throw new Error('illegal transition resolved -> closed');
      return {};
    });
    const out = await sweepAutoCloseResolved(NOW, 7);
    expect(out).toEqual({ closed: 1, skipped: 0, failed: 1 });
    const tx = h.queries.map((q) => q.text.trim()).filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t));
    expect(tx).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  });
});
