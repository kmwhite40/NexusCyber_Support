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
    expect(h.queries.some((q) => /last_checked_at/.test(q.text))).toBe(false);
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
