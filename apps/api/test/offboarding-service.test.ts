// Control-flow pins for the offboarding service. Not tests of SQL text — Postgres is not under
// test. They pin the properties that are otherwise one deletable line each:
//   (a) the feature stays dark when disabled, and refuses BEFORE any I/O;
//   (b) authorize() is called with the TICKET's organization, never the caller's;
//   (c) a stale fingerprint refuses rather than executing a plan nobody approved;
//   (d) a scheduled_for in the past refuses rather than firing on the next sweep;
//   (e) the run is persisted as kind='offboarding', status='scheduled', WITH the org (RLS is
//       not inherited through the foreign key).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Principal } from '../src/types.js';

const TICKET = '11111111-1111-1111-1111-111111111111';
const TICKET_ORG = '22222222-2222-2222-2222-222222222222';

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
    withOrgContext: vi.fn(async (_ctx: any, fn: any) => fn(sql)),
    authorize: vi.fn(),
    audit: vi.fn(async () => {}),
    getProvisioningGraph: vi.fn(),
    config: {
      provisioning: {
        enabled: true,
        tenantId: '55555555-5555-5555-5555-555555555555',
        clientId: 'c', clientSecret: 's', cloud: 'gcchigh' as const,
        upnDomain: 'sbsfederal.com',
        baselineSkus: ['SPE_E3_USGOV_GCCHIGH'],
        cloudPcPolicy: 'SBSFederal Cloud PC',
        cloudPcApiVersion: 'beta' as const,
      },
    },
  };
});

vi.mock('../src/db/pool.js', () => ({
  withSystemContext: h.withSystemContext, withOrgContext: h.withOrgContext, pool: {},
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/authz/pdp.js', () => ({
  authorize: h.authorize, can: () => true, decide: () => ({ allow: true, reason: 'permit' }),
}));
vi.mock('../src/modules/audit.js', () => ({ audit: h.audit }));
vi.mock('../src/integrations/m365/provisioning-runtime.js', () => ({
  getProvisioningGraph: h.getProvisioningGraph,
}));

const offboarding = await import('../src/modules/offboarding/index.js');

const actor: Principal = {
  id: '99999999-9999-9999-9999-999999999999',
  plane: 'nexus', email: 'agent@nexus.local', displayName: 'Agent',
  // Deliberately NOT the ticket's org, so an org mix-up cannot hide behind them being equal.
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  roles: ['ServiceDeskManager'], permissions: ['provisioning.execute'],
  assignedOrgs: [TICKET_ORG], allOrgs: false, elevated: false,
};

const ANSWERS = { legal_first_name: 'Jane', legal_last_name: 'Doe', last_day: '2026-09-02' };

function graphDouble() {
  return {
    graph: {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/users?$filter=')) {
          return { value: [{ id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe', accountEnabled: true }] };
        }
        if (path.includes('/memberOf')) return { value: [{ id: 'g-1', '@odata.type': '#microsoft.graph.group' }] };
        if (path.includes('/licenseDetails')) return { value: [{ skuId: 'sku-e3' }] };
        if (path.includes('/mailboxSettings')) return {};
        return { value: [] };
      }),
      post: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      del: vi.fn(async () => null),
    },
  };
}

const defaultRows = () => (text: string) => {
  if (/FROM tickets/.test(text)) {
    return [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding', custom_fields: ANSWERS }];
  }
  if (/INSERT INTO provisioning_runs/.test(text)) return [{ id: 'run-1' }];
  return [];
};

beforeEach(() => {
  vi.resetAllMocks();
  h.queries.length = 0;
  h.config.provisioning.enabled = true;
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.withOrgContext.mockImplementation(async (_ctx: any, fn: any) => fn(h.sql));
  h.getProvisioningGraph.mockImplementation(async () => graphDouble());
  h.audit.mockImplementation(async () => {});
  h.setDbRows(defaultRows());
});

describe('(a) the feature stays dark when disabled', () => {
  beforeEach(() => { h.config.provisioning.enabled = false; });

  it('refuses preview clearly, before ANY I/O', async () => {
    await expect(offboarding.preview(actor, TICKET)).rejects.toThrow(/not enabled/);
    expect(h.withSystemContext).not.toHaveBeenCalled();
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('refuses schedule clearly, before ANY I/O', async () => {
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/not enabled/);
    expect(h.withSystemContext).not.toHaveBeenCalled();
  });
});

describe('(b) authorization is bound to the ticket organization', () => {
  it('authorizes against the ticket org, not the caller org', async () => {
    await offboarding.preview(actor, TICKET);
    expect(h.authorize).toHaveBeenCalledWith(actor, 'provisioning.execute', { organizationId: TICKET_ORG });
  });
});

describe('(c) a previewed plan binds the run', () => {
  it('returns a fingerprint alongside the plan', async () => {
    const plan = await offboarding.preview(actor, TICKET);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.inactiveName).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });

  it('refuses to schedule on a fingerprint that no longer matches', async () => {
    await expect(offboarding.schedule(actor, TICKET, 'stale-fingerprint', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/changed since/i);
    expect(h.queries.some((q) => /INSERT INTO provisioning_runs/.test(q.text))).toBe(false);
  });
});

describe('(d) scheduling refuses a moment that has already passed', () => {
  it('rejects a past scheduled_for rather than firing on the next sweep', async () => {
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, '2020-01-01T00:00:00Z'))
      .rejects.toThrow(/in the past/i);
  });

  it('rejects a scheduled_for that is not a valid instant', async () => {
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, 'next friday'))
      .rejects.toThrow(/valid instant/i);
  });
});

describe('(e) the run is persisted correctly', () => {
  it('stores kind=offboarding and status=scheduled', async () => {
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z');
    const insert = h.queries.find((q) => /INSERT INTO provisioning_runs/.test(q.text))!;
    expect(insert.text).toContain('offboarding');
    expect(insert.text).toContain('scheduled');
  });

  it('supplies the ticket organization on the insert — RLS is not inherited', async () => {
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z');
    const insert = h.queries.find((q) => /INSERT INTO provisioning_runs/.test(q.text))!;
    expect(insert.params).toContain(TICKET_ORG);
  });

  it('refuses to schedule a plan carrying blockers', async () => {
    h.setDbRows((text: string) => {
      if (/FROM tickets/.test(text)) {
        return [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding',
                  custom_fields: { ...ANSWERS, legal_hold: true } }];
      }
      return [];
    });
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/blocker/i);
  });
});
