import { describe, it, expect, beforeEach, vi } from 'vitest';

const ORG = '22222222-2222-2222-2222-222222222222';
const DEPARTING = '33333333-3333-3333-3333-333333333333';

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
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, pool: {} }));

const { recordHold } = await import('../src/modules/retention/index.js');

const baseInput = () => ({
  organizationId: ORG,
  runId: '44444444-4444-4444-4444-444444444444',
  ticketId: '11111111-1111-1111-1111-111111111111',
  upn: 'jane.doe@sbsfederal.com',
  entraObjectId: 'entra-obj-1',
  displayName: 'Jane Doe',
  offboardedAt: new Date('2026-09-02T12:00:00Z'),
  directoryRoleCount: 0,
  departingUserId: DEPARTING,
});

const defaultRows = () => (text: string) => {
  if (/INSERT INTO retention_holds/.test(text)) return [{ id: 'hold-1' }];
  return [];
};

beforeEach(() => {
  vi.resetAllMocks();
  h.queries.length = 0;
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.setDbRows(defaultRows());
});

describe('recordHold', () => {
  it('gathers Nexus permissions and elevation grants for the departing user', async () => {
    await recordHold(baseInput());
    expect(h.queries.some((q) => /FROM elevation_grants/.test(q.text))).toBe(true);
    expect(h.queries.some((q) => /role_permissions/.test(q.text))).toBe(true);
  });

  it('does NOT filter elevation grants by status', async () => {
    // An expired or revoked grant still means the privilege existed. Filtering here would
    // silently downgrade exactly the people the seven-year rule targets.
    await recordHold(baseInput());
    const grants = h.queries.find((q) => /FROM elevation_grants/.test(q.text))!;
    expect(grants.text).not.toMatch(/status\s*=/);
  });

  it('writes the denormalized identity, not just the references', async () => {
    await recordHold(baseInput());
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(ins.params).toContain('jane.doe@sbsfederal.com');
    expect(ins.params).toContain('entra-obj-1');
    expect(ins.params).toContain('Jane Doe');
  });

  it('supplies the organization explicitly — RLS is not inherited', async () => {
    await recordHold(baseInput());
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(ins.params).toContain(ORG);
  });

  it('classifies a directory-role holder as privileged, seven years out', async () => {
    const out = await recordHold({ ...baseInput(), directoryRoleCount: 2 });
    expect(out.retentionClass).toBe('privileged');
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(String(ins.params).includes('2033-09-02')).toBe(true);
  });

  it('classifies an account with no evidence as standard, one year out', async () => {
    const out = await recordHold(baseInput());
    expect(out.retentionClass).toBe('standard');
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(String(ins.params).includes('2027-09-02')).toBe(true);
  });

  it('classifies on an expired elevation grant alone', async () => {
    h.setDbRows((text: string) => {
      if (/FROM elevation_grants/.test(text)) {
        return [{ status: 'expired', break_glass: false, granted_permissions: ['admin.superuser'] }];
      }
      if (/INSERT INTO retention_holds/.test(text)) return [{ id: 'hold-1' }];
      return [];
    });
    expect((await recordHold(baseInput())).retentionClass).toBe('privileged');
  });

  it('does not create a second live hold for the same account', async () => {
    // The partial unique index refuses it; the service surfaces that as a no-op, not a crash.
    h.setDbRows(() => []);
    const out = await recordHold(baseInput());
    expect(out.holdId).toBeNull();
  });

  it('skips the user lookups entirely when there is no departing user reference', async () => {
    await recordHold({ ...baseInput(), departingUserId: null });
    expect(h.queries.some((q) => /FROM elevation_grants/.test(q.text))).toBe(false);
  });
});
