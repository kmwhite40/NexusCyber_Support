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
        offboardingEnabled: true,
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

// The REAL offboarding intake: a reference to the departing person, not their name. Building
// against onboarding's legal_first_name/legal_last_name meant every production preview derived
// an empty UPN and found no user.
const DEPARTING = '33333333-3333-3333-3333-333333333333';
const ANSWERS = { departing_user: DEPARTING, last_day: '2026-09-02' };

function graphDouble() {
  return {
    graph: {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/users?$filter=')) {
          // Only answers for the UPN resolved from the Nexus user record — a lookup for anything
          // else returns nothing, so a wrong UPN cannot pass unnoticed.
          if (!decodeURIComponent(path).includes('jane.doe@sbsfederal.com')) return { value: [] };
          return { value: [{ id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe', accountEnabled: true, givenName: 'Jane', surname: 'Doe' }] };
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

const defaultRows = () => (text: string, params: unknown[]) => {
  if (/FROM tickets/.test(text)) {
    return [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding', custom_fields: ANSWERS }];
  }
  // The departing person's Nexus record: this is where the UPN comes from.
  if (/FROM users/.test(text)) {
    return params?.[0] === DEPARTING
      ? [{ id: DEPARTING, email: 'jane.doe@sbsfederal.com', display_name: 'Jane Doe' }]
      : [];
  }
  // A completed approval on the ticket.
  if (/FROM approvals/.test(text)) return [{ status: 'approved' }];
  // The organization that owns the provisioning tenant (organizations.entra_tenant_id).
  if (/entra_tenant_id/.test(text)) return [{ id: TICKET_ORG }];
  if (/INSERT INTO provisioning_runs/.test(text)) return [{ id: 'run-1' }];
  return [];
};

/** defaultRows with one table's answer replaced — for the refusal cases below. */
const rowsExcept = (override: (text: string, params: unknown[]) => any[] | null) =>
  (text: string, params: unknown[]) => {
    const o = override(text, params);
    return o === null ? defaultRows()(text, params) : o;
  };

beforeEach(() => {
  vi.resetAllMocks();
  h.queries.length = 0;
  h.config.provisioning.enabled = true;
  h.config.provisioning.offboardingEnabled = true;
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.withOrgContext.mockImplementation(async (_ctx: any, fn: any) => fn(h.sql));
  h.getProvisioningGraph.mockImplementation(async () => graphDouble());
  h.audit.mockImplementation(async () => {});
  h.setDbRows(defaultRows());
});

describe('(a) the feature stays dark when disabled', () => {
  beforeEach(() => { h.config.provisioning.enabled = false; h.config.provisioning.offboardingEnabled = false; });

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

// Enabling onboarding must NOT arm account teardown. Offboarding carries its own gate on top
// of the shared tenant configuration, so the constructive half can be switched on alone.
describe('(a2) offboarding has its own gate', () => {
  it('refuses when provisioning is on but offboarding was not asked for', async () => {
    h.config.provisioning.offboardingEnabled = false;
    await expect(offboarding.preview(actor, TICKET)).rejects.toThrow(/offboarding is not enabled/i);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });

  it('refuses to schedule for the same reason', async () => {
    h.config.provisioning.offboardingEnabled = false;
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/offboarding is not enabled/i);
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
    h.setDbRows(rowsExcept((text) => (/FROM tickets/.test(text)
      ? [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding',
           custom_fields: { ...ANSWERS, legal_hold: true } }]
      : null)));
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/blocker/i);
  });
});

describe('(f) the departing account is resolved from the ticket, not from form text', () => {
  it('uses the departing_user reference to find the directory account', async () => {
    const plan = await offboarding.preview(actor, TICKET);
    expect(plan.upn).toBe('jane.doe@sbsfederal.com');
    expect(plan.inactiveName).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
    expect(plan.blockers).toEqual([]);
  });

  it('blocks when the request names no departing user at all', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM tickets/.test(text)
      ? [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding',
           custom_fields: { last_day: '2026-09-02' } }]
      : null)));
    const plan = await offboarding.preview(actor, TICKET);
    expect(plan.blockers.map((b) => b.code)).toContain('no_departing_user');
  });

  it('blocks when the referenced user is not a known Nexus record', async () => {
    h.setDbRows(rowsExcept((text, params) => {
      if (/FROM tickets/.test(text)) {
        return [{ id: TICKET, organization_id: TICKET_ORG, category: 'user.offboarding',
                  custom_fields: { departing_user: 'ffffffff-ffff-ffff-ffff-ffffffffffff', last_day: '2026-09-02' } }];
      }
      if (/FROM users/.test(text)) return [];  // the reference names nobody
      return null;
    }));
    const plan = await offboarding.preview(actor, TICKET);
    expect(plan.blockers.map((b) => b.code)).toContain('no_departing_user');
  });
});

// These gates exist on the ONBOARDING side (requireApprovedOnboardingRequest,
// requireProvisioningTenantOrg) and were not ported. Without them any provisioning.execute
// holder could arm a teardown on an unapproved ticket, or drive writes into the SBS tenant from
// a ticket belonging to some other customer org. A hidden button is not an authorization
// control; the ticket page comment claimed the server enforced this, and it did not.
describe('(g) scheduling is gated on the request itself, not just the permission', () => {
  it('refuses a ticket that is not an offboarding request', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM tickets/.test(text)
      ? [{ id: TICKET, organization_id: TICKET_ORG, category: 'incident', custom_fields: ANSWERS }]
      : null)));
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/user\.offboarding/i);
  });

  it('refuses when the request carries no approval at all', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM approvals/.test(text) ? [] : null)));
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/approval/i);
  });

  it('refuses when an approval is still outstanding', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM approvals/.test(text)
      ? [{ status: 'approved' }, { status: 'requested' }] : null)));
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/approved/i);
  });

  it('refuses when an approval was rejected', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM approvals/.test(text)
      ? [{ status: 'rejected' }] : null)));
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/approved/i);
  });

  it('refuses a ticket from an org that does not own the provisioning tenant', async () => {
    h.setDbRows(rowsExcept((text) => (/entra_tenant_id/.test(text)
      ? [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] : null)));
    await expect(offboarding.schedule(actor, TICKET, 'fp', '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/does not belong to the organization/i);
  });

  it('refuses preview on the same grounds, not just schedule', async () => {
    h.setDbRows(rowsExcept((text) => (/FROM approvals/.test(text) ? [] : null)));
    await expect(offboarding.preview(actor, TICKET)).rejects.toThrow(/approval/i);
  });
});

describe('(h) one armed run per ticket', () => {
  it('refuses to arm a second run while one is already scheduled', async () => {
    // Two armed runs for one ticket means the teardown fires twice, and the second fires against
    // an account the first already renamed and stripped.
    h.setDbRows(rowsExcept((text) => (/INSERT INTO provisioning_runs/.test(text)
      ? []          // the conditional insert matched nothing: a run is already in flight
      : null)));
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/already/i);
  });

  it('guards with a conditional insert rather than check-then-insert', async () => {
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z');
    const insert = h.queries.find((q) => /INSERT INTO provisioning_runs/.test(q.text))!;
    expect(insert.text).toContain('NOT EXISTS');
  });
});

// Arming without cancelling was the wrong shape to ship: once a plan was armed the only way to
// stop the teardown was a manual UPDATE against production. Plans change, start dates move,
// people withdraw resignations.
describe('(i) an armed run can be cancelled', () => {
  const rowsWithScheduledRun = () => rowsExcept((text) => {
    if (/UPDATE provisioning_runs/.test(text) && /cancelled/.test(text)) return [{ id: 'run-1' }];
    return null;
  });

  it('cancels a scheduled run', async () => {
    h.setDbRows(rowsWithScheduledRun());
    const out = await offboarding.cancel(actor, TICKET, 'reassigned to a later date');
    expect(out.cancelled).toBe(1);
    const upd = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /cancelled/.test(q.text))!;
    expect(upd.text).toContain("status = 'scheduled'");
  });

  it('only cancels runs that are still scheduled, never one already running', async () => {
    // A run mid-execution has already made directory writes; "cancelled" would misdescribe it.
    h.setDbRows(rowsWithScheduledRun());
    await offboarding.cancel(actor, TICKET, 'nope');
    const upd = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /cancelled/.test(q.text))!;
    expect(upd.text).not.toContain("'running'");
  });

  it('reports when there was nothing armed to cancel', async () => {
    h.setDbRows(rowsExcept(() => null)); // no matching run
    const out = await offboarding.cancel(actor, TICKET, 'nothing here');
    expect(out.cancelled).toBe(0);
  });

  it('scopes the cancel to the ticket organization', async () => {
    h.setDbRows(rowsWithScheduledRun());
    await offboarding.cancel(actor, TICKET, 'why');
    const upd = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /cancelled/.test(q.text))!;
    expect(upd.params).toContain(TICKET_ORG);
  });

  it('still works when the feature has since been switched off', async () => {
    // Disabling the flag stops the sweeper starting, but an already-armed run must remain
    // stoppable — and re-enabling later would otherwise fire a teardown nobody still wants.
    h.config.provisioning.offboardingEnabled = false;
    h.setDbRows(rowsWithScheduledRun());
    await expect(offboarding.cancel(actor, TICKET, 'switched off')).resolves.toBeTruthy();
  });

  it('records the reason, so history says why it did not happen', async () => {
    h.setDbRows(rowsWithScheduledRun());
    await offboarding.cancel(actor, TICKET, 'start date moved to October');
    const upd = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /cancelled/.test(q.text))!;
    expect(JSON.stringify(upd.params)).toContain('start date moved to October');
  });
});

describe('(j) the arming guard has both layers', () => {
  it('turns the index unique-violation into the same 409 as the conditional insert', async () => {
    // Layer 1 (WHERE NOT EXISTS) is statistical under READ COMMITTED; layer 2 (the partial
    // unique index, 0071) is structural. The caller must not be able to tell them apart, and no
    // raw database error may reach the client.
    h.setDbRows(rowsExcept((text) => {
      if (/INSERT INTO provisioning_runs/.test(text)) {
        const e: any = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        e.constraint = 'provisioning_runs_one_inflight_per_ticket';
        throw e;
      }
      return null;
    }));
    const { fingerprint } = await offboarding.preview(actor, TICKET);
    await expect(offboarding.schedule(actor, TICKET, fingerprint, '2099-01-01T00:00:00Z'))
      .rejects.toThrow(/already/i);
  });
});
