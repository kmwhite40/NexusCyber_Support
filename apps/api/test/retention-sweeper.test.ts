import { describe, it, expect, beforeEach, vi } from 'vitest';

const ORG = '22222222-2222-2222-2222-222222222222';

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
    graphGet: vi.fn(),
    getProvisioningGraph: vi.fn(),
    nextTicketNumber: vi.fn(async () => 'STRA-000042'),
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, pool: {} }));
vi.mock('../src/integrations/m365/provisioning-runtime.js', () => ({
  getProvisioningGraph: h.getProvisioningGraph,
}));
vi.mock('../src/modules/tickets.js', () => ({ nextTicketNumber: h.nextTicketNumber }));

const { sweepRetentionHolds } = await import('../src/jobs/retention-sweeper.js');
// A REAL GraphError, not a shape that merely looks like one: accountExists distinguishes
// "gone" from "could not ask" with an instanceof check, and a double that fakes the name
// would silently exercise the wrong branch — which is exactly how the phase-1 review findings
// stayed hidden behind green tests.
const { GraphError } = await import('../src/integrations/m365/graph-client.js');

/** Arms the DB double with one active hold and the Graph double with its answer. */
function armHold(opts: { present: boolean | 'error'; retain_until: string }) {
  h.setDbRows((text: string) => {
    if (/FROM retention_holds/.test(text)) {
      return [{
        id: 'hold-1', organization_id: ORG, upn: 'jane.doe@sbsfederal.com',
        entra_object_id: 'entra-obj-1', display_name_at_offboard: 'Jane Doe',
        retention_class: 'standard', retain_until: opts.retain_until,
        offboarded_at: '2026-09-02T00:00:00.000Z',
      }];
    }
    // The INSERT returns the new id — without it there is nothing to publish with, and the
    // double would silently exercise a path the real database never takes.
    if (/INSERT INTO tickets/.test(text)) return [{ id: 'ticket-1' }];
    return [];
  });
  h.graphGet.mockImplementation(async () => {
    if (opts.present === 'error') throw new Error('graph unreachable');
    if (opts.present === false) throw new GraphError(404, 'not found');
    return { id: 'entra-obj-1' };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.queries.length = 0;
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.getProvisioningGraph.mockImplementation(async () => ({ graph: { get: h.graphGet } }));
  h.nextTicketNumber.mockImplementation(async () => 'STRA-000042');
  h.setDbRows(() => []);
});

describe('sweepRetentionHolds', () => {
  it('only ever looks at active holds, so a breach is not re-reported every day', async () => {
    armHold({ present: true, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const sel = h.queries.find((q) => /FROM retention_holds/.test(q.text))!;
    expect(sel.text).toContain("state = 'active'");
  });

  it('raises a ticket naming the account when one vanished early', async () => {
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.breached).toBe(1);
    const ins = h.queries.find((q) => /INSERT INTO tickets/.test(q.text))!;
    expect(JSON.stringify(ins.params)).toContain('jane.doe@sbsfederal.com');
    // The state is a bound parameter, not interpolated text — check where it actually lives.
    expect(h.queries.some((q) => /UPDATE retention_holds/.test(q.text) && q.params.includes('breached'))).toBe(true);
  });

  it('raises a disposal ticket when the date has passed and the account is still there', async () => {
    armHold({ present: true, retain_until: '2020-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.eligible).toBe(1);
    expect(h.queries.some((q) => /INSERT INTO tickets/.test(q.text))).toBe(true);
  });

  it('records a disposal with no alarm when the account went after its date', async () => {
    armHold({ present: false, retain_until: '2020-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.disposed).toBe(1);
    expect(h.queries.some((q) => /INSERT INTO tickets/.test(q.text))).toBe(false);
  });

  it('does NOT stamp last_checked_at when the check failed', async () => {
    // A tenant outage recorded as "confirmed present" is the one reading that lets a real breach
    // pass unnoticed.
    armHold({ present: 'error', retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.unchecked).toBe(1);
    // Specifically: no WRITE of last_checked_at. It appears in the SELECT's ORDER BY (rotation),
    // so matching the bare column name across all queries would pass for the wrong reason.
    expect(h.queries.some((q) => /UPDATE retention_holds/.test(q.text) && /last_checked_at/.test(q.text)))
      .toBe(false);
  });

  it('reports how many holds it could not check, so a failing sweeper is visible', async () => {
    armHold({ present: 'error', retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.unchecked).toBeGreaterThan(0);
  });

  it('NEVER deletes anything', async () => {
    armHold({ present: true, retain_until: '2020-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(h.queries.some((q) => /DELETE FROM/.test(q.text))).toBe(false);
  });

  it('scopes every hold write to the hold organization', async () => {
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const upd = h.queries.find((q) => /UPDATE retention_holds/.test(q.text))!;
    expect(upd.params).toContain(ORG);
  });

  it('does not reach for the tenant at all when there are no holds', async () => {
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
    expect(out).toEqual({ checked: 0, breached: 0, eligible: 0, disposed: 0, unchecked: 0 });
  });
});

describe('sweeper infrastructure', () => {
  it('allocates the ticket number inside a real transaction', async () => {
    // nextTicketNumber takes pg_advisory_xact_lock, which is released the instant its transaction
    // ends. withSystemContext opens NO transaction, so without an explicit BEGIN the lock is
    // dropped immediately and the duplicate-number race returns — the same race 708b7ff fixed in
    // ingest.ts by adding exactly this.
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const texts = h.queries.map((q) => q.text);
    const begin = texts.findIndex((t) => /^\s*BEGIN/i.test(t));
    const insert = texts.findIndex((t) => /INSERT INTO tickets/.test(t));
    const commit = texts.findIndex((t) => /^\s*COMMIT/i.test(t));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(insert);
    expect(commit).toBeGreaterThan(insert);
  });

  it('formats dates in the ticket as ISO, not as a JS Date string', async () => {
    // pg returns timestamptz as a Date; String(date).slice(0,10) yields "Wed Sep 02".
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    h.setDbRows((text: string) => {
      if (/FROM retention_holds/.test(text)) {
        return [{
          id: 'hold-1', organization_id: ORG, upn: 'jane.doe@sbsfederal.com',
          entra_object_id: 'entra-obj-1', display_name_at_offboard: 'Jane Doe',
          retention_class: 'standard',
          retain_until: new Date('2099-01-01T00:00:00Z'),      // a Date, as pg gives it
          offboarded_at: new Date('2026-09-02T00:00:00Z'),
        }];
      }
      return [];
    });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const ins = h.queries.find((q) => /INSERT INTO tickets/.test(q.text))!;
    const body = JSON.stringify(ins.params);
    expect(body).toContain('2099-01-01');
    expect(body).not.toMatch(/Mon |Tue |Wed |Thu |Fri |Sat |Sun /);
  });
});

describe('startRetentionSweeper', () => {
  it('primes an immediate first run rather than waiting a full day', async () => {
    // setInterval alone means the first sweep is 24h after boot AND the timer resets on every
    // restart — on a frequently redeployed API it may never run at all. retention-purge and
    // sla-sweeper both prime with a setTimeout for exactly this reason.
    const { startRetentionSweeper } = await import('../src/jobs/retention-sweeper.js');
    vi.useFakeTimers();
    const timer = startRetentionSweeper(24 * 60 * 60 * 1000);
    const before = h.queries.length;
    await vi.advanceTimersByTimeAsync(60_000);   // one minute, nowhere near a day
    expect(h.queries.length).toBeGreaterThan(before);
    clearInterval(timer);
    vi.useRealTimers();
  });
});

describe('sweep robustness', () => {
  it('rotates on last_checked_at so a large backlog cannot starve the newest holds', async () => {
    // ORDER BY retain_until alone meant that past the batch limit, the furthest-dated holds —
    // i.e. the newest PRIVILEGED seven-year ones — were never reached, while the sweep happily
    // reported zero unchecked.
    armHold({ present: true, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const sel = h.queries.find((q) => /FROM retention_holds/.test(q.text))!;
    expect(sel.text).toMatch(/last_checked_at/);
  });

  it('records the state BEFORE raising the ticket, so a failure cannot duplicate it', async () => {
    // raiseTicket ran first across a separate connection: a ticket raised but not recorded would
    // be raised again the next day, and every day after.
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const texts = h.queries.map((q) => q.text);
    const state = texts.findIndex((t) => /UPDATE retention_holds/.test(t));
    const ticket = texts.findIndex((t) => /INSERT INTO tickets/.test(t));
    expect(state).toBeLessThan(ticket);
  });

  it('one failing hold does not abort the rest of the sweep', async () => {
    let call = 0;
    h.setDbRows((text: string) => {
      if (/FROM retention_holds/.test(text)) {
        return [
          { id: 'hold-1', organization_id: ORG, upn: 'a@x.gov', entra_object_id: 'o-1',
            display_name_at_offboard: 'A', retention_class: 'standard',
            retain_until: '2099-01-01T00:00:00Z', offboarded_at: '2026-09-02T00:00:00Z' },
          { id: 'hold-2', organization_id: ORG, upn: 'b@x.gov', entra_object_id: 'o-2',
            display_name_at_offboard: 'B', retention_class: 'standard',
            retain_until: '2099-01-01T00:00:00Z', offboarded_at: '2026-09-02T00:00:00Z' },
        ];
      }
      return [];
    });
    h.graphGet.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new GraphError(500, 'boom');   // first hold blows up
      return { id: 'o-2' };
    });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.checked).toBe(2);   // the second hold was still reached
  });
});

describe('the ticket actually reaches someone', () => {
  it('sets a resolution due date so it can breach rather than sit forever', async () => {
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const ins = h.queries.find((q) => /INSERT INTO tickets/.test(q.text))!;
    expect(ins.text).toContain('resolution_due_at');
  });

  it('publishes ticket.created AFTER the commit, not inside it', async () => {
    // Inside the transaction it would announce a ticket a rollback could erase.
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    const seen: string[] = [];
    const { subscribe } = await import('../src/events/bus.js');
    subscribe('ticket.created', () => { seen.push('ticket.created'); });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBe(1);
  });
});
