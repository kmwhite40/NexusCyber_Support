// Control-flow pins for the provisioning service.
//
// These are NOT tests of SQL text — Postgres is not under test here. They pin the six safety
// properties this task exists to establish, each of which is otherwise a single line a future
// edit deletes silently:
//   (a) preview and provision build their plan through ONE planning path;
//   (b) a blocker-carrying plan is refused at the SERVICE level, before any run row is inserted
//       and before any Graph write;
//   (c) authorize() is called with the TICKET's organization, never a caller-supplied one;
//   (d) audit() receives the ticket's organization_id, never null;
//   (e) the provisioning_steps INSERT supplies organization_id (RLS is not inherited through
//       the foreign key, so a missing value is a NOT NULL violation at best and a
//       cross-tenant-invisible row at worst);
//   (f) with the feature disabled, the refusal happens before ANY I/O.
// Plus the in-flight-run guard and the TAP's absence from every persistence sink.
//
// The DB pool, the config, the Graph runtime, the PDP, the audit log and the mail runtime are
// all replaced with recorders, so the assertions are about what the service DID, in what order,
// with which arguments.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Principal } from '../src/types.js';
import { GraphError } from '../src/integrations/m365/graph-client.js';

const TICKET = '11111111-1111-1111-1111-111111111111';
const TICKET_ORG = '22222222-2222-2222-2222-222222222222';
const SUPERVISOR = '33333333-3333-3333-3333-333333333333';
const RUN = '44444444-4444-4444-4444-444444444444';
const TAP = 'TAP-SECRET-DO-NOT-PERSIST';
const PERSONAL_EMAIL = 'ada.personal@gmail.example';
const WORK_EMAIL = 'supervisor@sbsfederal.com';

// vi.mock factories are hoisted above the imports, so everything they close over has to be
// created in a hoisted block too.
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
    queries,
    sql,
    setDbRows: (fn: (text: string, params: unknown[]) => any[]) => { dbRows = fn; },
    withSystemContext: vi.fn(async (fn: any) => fn(sql)),
    withOrgContext: vi.fn(async (_ctx: any, fn: any) => fn(sql)),
    authorize: vi.fn(),
    audit: vi.fn(async () => {}),
    getProvisioningGraph: vi.fn(),
    getNotificationAdapter: vi.fn(),
    sendEmail: vi.fn(async () => ({ status: 'sent', providerMessageId: 'graph:1' })),
    config: {
      provisioning: {
        enabled: true,
        tenantId: '55555555-5555-5555-5555-555555555555',
        clientId: 'c', clientSecret: 's', cloud: 'gcchigh',
        upnDomain: 'sbsfederal.com',
        baselineSkus: ['SPE_E3_USGOV_GCCHIGH'],
        cloudPcPolicy: 'SBSFederal Cloud PC',
        cloudPcApiVersion: 'beta' as const,
      },
    },
  };
});

vi.mock('../src/db/pool.js', () => ({
  withSystemContext: h.withSystemContext,
  withOrgContext: h.withOrgContext,
  pool: {},
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/authz/pdp.js', () => ({
  authorize: h.authorize,
  can: () => true,
  decide: () => ({ allow: true, reason: 'permit' }),
}));
vi.mock('../src/modules/audit.js', () => ({ audit: h.audit }));
vi.mock('../src/integrations/m365/provisioning-runtime.js', () => ({
  getProvisioningGraph: h.getProvisioningGraph,
}));
vi.mock('../src/integrations/m365/runtime.js', () => ({
  getNotificationAdapter: h.getNotificationAdapter,
}));

const provisioning = await import('../src/modules/provisioning/index.js');

const actor: Principal = {
  id: '99999999-9999-9999-9999-999999999999',
  plane: 'nexus',
  email: 'agent@nexus.local',
  displayName: 'Agent',
  // Deliberately NOT the ticket's organization: every org-scoped call the service makes must
  // use the TICKET's org, so a mix-up cannot hide behind them being equal.
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  roles: ['ServiceDeskManager'],
  permissions: ['provisioning.execute', 'ticket.create'],
  assignedOrgs: [TICKET_ORG],
  allOrgs: false,
  elevated: false,
};

const ANSWERS = {
  legal_first_name: 'Ada',
  legal_last_name: 'Lovelace',
  security_groups: 'All Staff',
  supervisor: SUPERVISOR,
};

/** Graph doubles. `groups` drives whether the requested group resolves. */
function graphDouble(opts: { groups?: any[] } = {}) {
  const graph = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith('/subscribedSkus')) {
        return { value: [{ skuId: 'sku-e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', prepaidUnits: { enabled: 10 }, consumedUnits: 1 }] };
      }
      if (path.startsWith('/users?$filter=')) return { value: [] }; // no existing account
      if (path.startsWith('/groups?$filter=')) {
        return { value: opts.groups ?? [{ id: 'g1', displayName: 'All Staff' }] };
      }
      if (path.includes('/licenseDetails')) return { value: [] };
      return { value: [] };
    }),
    post: vi.fn(async (path: string) => {
      if (path === '/users') return { id: 'u-new' };
      if (path.includes('temporaryAccessPassMethods')) return { temporaryAccessPass: TAP };
      return {};
    }),
    patch: vi.fn(),
  };
  const cloudPc = { get: vi.fn(async () => ({ value: [] })), post: vi.fn(), patch: vi.fn() };
  return { graph, cloudPc, graphEndpoint: 'https://graph.microsoft.us' };
}

/**
 * Default DB responder: an APPROVED `user.provisioning` ticket in the organization that owns
 * the provisioning tenant, no PII rows, run insert succeeds, and a supervisor who is an active
 * Nexus platform user scoped to that org.
 *
 * Every one of those clauses is now load-bearing — the service refuses on each of them
 * independently — so the overrides exist to knock exactly one out at a time.
 */
function defaultRows(over: {
  runInsert?: any[];
  supervisorStatus?: string;
  supervisorRows?: any[];
  ticketOrg?: string;
  ticketCategory?: string | null;
  catalogItem?: any[];
  approvals?: any[];
  tenantOrgRows?: any[];
} = {}) {
  return (text: string) => {
    if (/FROM tickets WHERE id/.test(text)) {
      return [{
        id: TICKET,
        organization_id: over.ticketOrg ?? TICKET_ORG,
        category: over.ticketCategory === undefined ? 'user.provisioning' : over.ticketCategory,
        custom_fields: ANSWERS,
      }];
    }
    if (/FROM organizations WHERE entra_tenant_id/.test(text)) {
      return over.tenantOrgRows ?? [{ id: TICKET_ORG }];
    }
    if (/FROM service_catalog_items WHERE key/.test(text)) {
      return over.catalogItem ?? [{ key: 'user.provisioning', form_key: 'user_onboarding' }];
    }
    if (/FROM approvals WHERE subject_type/.test(text)) {
      return over.approvals ?? [{ status: 'approved' }];
    }
    if (/ticket_sensitive_fields/.test(text)) return [{ key: 'personal_email', value: PERSONAL_EMAIL }];
    if (/INSERT INTO provisioning_runs/.test(text)) return over.runInsert ?? [{ id: RUN }];
    if (/FROM users u/.test(text)) {
      return over.supervisorRows
        ?? [{ email: WORK_EMAIL, status: over.supervisorStatus ?? 'active' }];
    }
    return [];
  };
}

/**
 * Preview, then execute with the fingerprint that preview returned — the ONLY legitimate way to
 * provision, and therefore what every test that is not about the binding itself must do.
 * Deliberately not a shortcut that computes the fingerprint some other way: a helper that
 * bypassed preview would let the binding rot without a single test noticing.
 */
async function provisionApproved(ticketId = TICKET) {
  const plan = await provisioning.preview(actor, ticketId);
  h.queries.length = 0;
  return provisioning.provision(actor, ticketId, plan.fingerprint);
}

const find = (re: RegExp) => h.queries.filter((q) => re.test(q.text));

/** The partial unique index added in migration 0057. */
const IN_FLIGHT_INDEX = 'provisioning_runs_one_inflight_per_ticket';

/** A pg driver error, in the shape node-postgres actually throws. */
function pgError(code: string, constraint?: string) {
  const e: any = new Error(
    `duplicate key value violates unique constraint "${constraint ?? 'unnamed'}"`,
  );
  e.code = code;
  if (constraint) e.constraint = constraint;
  return e;
}

let g: ReturnType<typeof graphDouble>;

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a mockImplementation set inside one test (e.g. an
  // authorize() that throws) would otherwise leak into every test that follows it.
  vi.resetAllMocks();
  h.queries.length = 0;
  h.config.provisioning.enabled = true;
  g = graphDouble();
  // resetAllMocks wipes implementations, including the ones defined in the hoisted block, so
  // every double is re-armed here rather than relying on its original definition.
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.withOrgContext.mockImplementation(async (_ctx: any, fn: any) => fn(h.sql));
  h.getProvisioningGraph.mockImplementation(async () => g);
  h.sendEmail.mockImplementation(async () => ({ status: 'sent', providerMessageId: 'graph:1' }));
  h.audit.mockImplementation(async () => {});
  h.getNotificationAdapter.mockImplementation(async () => ({
    name: 'graph',
    capabilities: () => ({ email: true, teams: false }),
    sendEmail: h.sendEmail,
    sendTeams: vi.fn(),
  }));
  h.setDbRows(defaultRows());
});

describe('(a) preview and provision share ONE planning path', () => {
  it('persists exactly the plan preview returned', async () => {
    const { fingerprint, ...previewed } = await provisioning.preview(actor, TICKET);
    h.queries.length = 0;

    await provisioning.provision(actor, TICKET, fingerprint);
    const insert = find(/INSERT INTO provisioning_runs/)[0];
    expect(insert).toBeDefined();
    // params[2] is the plan jsonb. If provision ever grew its own planning path, this diverges.
    // The fingerprint is not part of the plan — it is the token that BINDS this plan to this
    // run — so it is destructured off rather than stored.
    expect(JSON.parse(insert.params[2] as string)).toEqual(previewed);
  });

  it('resolves group ids on the previewed plan, not only on the executed one', async () => {
    const previewed = await provisioning.preview(actor, TICKET);
    expect(previewed.steps.find((s) => s.key === 'add_groups')?.detail.groupIds).toEqual(['g1']);
  });
});

describe('(b) a blocker-carrying plan is refused before any write', () => {
  beforeEach(() => { g = graphDouble({ groups: [] }); }); // the requested group resolves to nothing

  it('surfaces the blocker in preview rather than throwing', async () => {
    const p = await provisioning.preview(actor, TICKET);
    expect(p.blockers.map((b) => b.code)).toEqual(['group_missing']);
  });

  it('rejects, inserts no run, and never issues a Graph write', async () => {
    await expect(provisionApproved()).rejects.toThrow(/blocker/);
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
    expect(find(/INSERT INTO provisioning_steps/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('(c) authorization is scoped to the TICKET organization', () => {
  it('authorizes provisioning.execute against the ticket org, not the actor org', async () => {
    await provisioning.preview(actor, TICKET);
    expect(h.authorize).toHaveBeenCalledWith(actor, 'provisioning.execute', { organizationId: TICKET_ORG });
    expect(h.authorize).not.toHaveBeenCalledWith(actor, 'provisioning.execute', { organizationId: actor.organizationId });
  });

  it('authorizes before any Graph traffic', async () => {
    h.authorize.mockImplementation(() => { throw new Error('forbidden'); });
    await expect(provisioning.preview(actor, TICKET)).rejects.toThrow(/forbidden/);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });
});

describe('(d) the audit row is org-scoped', () => {
  it('audits with the ticket organization_id, not null', async () => {
    await provisionApproved();
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [auditActor, input] = h.audit.mock.calls[0] as any[];
    expect(auditActor).toBe(actor);
    expect(input.organizationId).toBe(TICKET_ORG);
    expect(input.action).toBe('provisioning.executed');
    expect(input.resourceId).toBe(TICKET);
  });
});

describe('(e) provisioning_steps carries its own organization_id', () => {
  it('supplies the org on every step insert (RLS is not inherited through the FK)', async () => {
    await provisionApproved();
    const steps = find(/INSERT INTO provisioning_steps/);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s.params).toHaveLength(4);        // run_id, organization_id, step_key, position
      expect(s.params[0]).toBe(RUN);
      expect(s.params[1]).toBe(TICKET_ORG);
    }
  });

  it('supplies the org on the run insert too', async () => {
    await provisionApproved();
    expect(find(/INSERT INTO provisioning_runs/)[0].params[1]).toBe(TICKET_ORG);
  });
});

describe('(f) the feature stays dark when disabled', () => {
  beforeEach(() => { h.config.provisioning.enabled = false; });

  it('refuses preview clearly, before ANY I/O', async () => {
    await expect(provisioning.preview(actor, TICKET)).rejects.toThrow(/not enabled/);
    expect(h.withSystemContext).not.toHaveBeenCalled();
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('refuses provision clearly, before ANY I/O', async () => {
    await expect(provisionApproved()).rejects.toThrow(/not enabled/);
    expect(h.withSystemContext).not.toHaveBeenCalled();
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });

  it('returns no policy options rather than reaching for a tenant', async () => {
    expect(await provisioning.listCloudPcPolicies(actor)).toEqual([]);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });
});

describe('the in-flight run guard', () => {
  it('treats awaiting_cloudpc as in flight — the 30-90 minute window, not just running', async () => {
    await provisionApproved();
    const statuses = find(/INSERT INTO provisioning_runs/)[0].params[4] as string[];
    expect(statuses).toContain('running');
    // Regression: omitting this let an admin re-click Provision during a Cloud PC build and
    // mint a SECOND Temporary Access Pass for the same identity.
    expect(statuses).toContain('awaiting_cloudpc');
  });

  it('conflicts, and starts nothing, when the conditional insert matches an in-flight run', async () => {
    h.setDbRows(defaultRows({ runInsert: [] }));
    await expect(provisionApproved()).rejects.toThrow(/already in progress/);
    expect(find(/INSERT INTO provisioning_steps/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  // The second layer (migration 0057). Under READ COMMITTED both racers can pass the NOT EXISTS
  // check above, so the loser hits the partial unique index instead and gets a raw 23505. That
  // must look EXACTLY like the guard's clean 409 from outside — and must still start nothing,
  // because the alternative is a second Temporary Access Pass on a brand-new identity.
  it('translates the unique-violation race into the same 409 as the guard', async () => {
    h.setDbRows(defaultRows({ runInsert: [] }));
    const fromGuard: any = await provisionApproved().catch((e) => e);

    h.queries.length = 0;
    g.graph.post.mockClear();
    h.audit.mockClear();
    h.setDbRows((text, params) => {
      if (/INSERT INTO provisioning_runs/.test(text)) throw pgError('23505', IN_FLIGHT_INDEX);
      return defaultRows()(text, params);
    });
    const fromIndex: any = await provisionApproved().catch((e) => e);

    expect(fromIndex.status).toBe(409);
    expect(fromIndex.status).toBe(fromGuard.status);
    expect(fromIndex.detail).toBe(fromGuard.detail);      // indistinguishable to the caller
    expect(fromIndex.message).not.toMatch(/duplicate key/); // no raw database error escapes
    expect(find(/INSERT INTO provisioning_steps/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated unique violation for a run already in progress', async () => {
    h.setDbRows((text, params) => {
      if (/INSERT INTO provisioning_runs/.test(text)) throw pgError('23505', 'some_other_unique_index');
      return defaultRows()(text, params);
    });
    await expect(provisionApproved()).rejects.toThrow(/duplicate key/);
  });

  it('does not swallow a non-unique-violation database error', async () => {
    h.setDbRows((text, params) => {
      if (/INSERT INTO provisioning_runs/.test(text)) throw pgError('23502'); // not_null_violation
      return defaultRows()(text, params);
    });
    await expect(provisionApproved()).rejects.toThrow(/duplicate key/);
  });
});

describe('Temporary Access Pass containment across the write paths', () => {
  it('delivers to the supervisor WORK mailbox, never the personal address on the form', async () => {
    await provisionApproved();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const env = h.sendEmail.mock.calls[0][0] as any;
    expect(env.to).toBe(WORK_EMAIL);
    expect(JSON.stringify(env)).not.toContain(PERSONAL_EMAIL);
    expect(env.text).toContain(TAP); // the body is the ONE place the pass is allowed to be
  });

  it('never lets the pass reach the database, the audit detail, or the run plan', async () => {
    await provisionApproved();
    for (const q of h.queries) {
      expect(JSON.stringify(q.params)).not.toContain(TAP);
    }
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(TAP);
  });

  it('refuses to hand a live credential to a deactivated supervisor', async () => {
    h.setDbRows(defaultRows({ supervisorStatus: 'disabled' }));
    const r = await provisionApproved();
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.error).toMatch(/not active/);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('records the delivery without recording the pass', async () => {
    await provisionApproved();
    const rec = find(/INSERT INTO notification_deliveries/)[0];
    expect(rec.params).toEqual([TICKET_ORG, WORK_EMAIL, 'sent', 'graph:1']);
  });
});

describe('a successful run', () => {
  it('creates the account, licenses it, adds the resolved group, and closes the run', async () => {
    const r = await provisionApproved();
    expect(r.status).toBe('succeeded');
    expect(r.runId).toBe(RUN);
    expect(r.outcomes.map((o) => o.key)).toEqual(['create_user', 'assign_licenses', 'add_groups', 'issue_tap']);
    expect(g.graph.post.mock.calls.map((c) => c[0])).toEqual([
      '/users',
      '/users/u-new/assignLicense',
      '/groups/g1/members/$ref',
      '/users/u-new/authentication/temporaryAccessPassMethods',
    ]);
    expect(find(/UPDATE provisioning_runs/)[0].params).toEqual([RUN, 'succeeded', null]);
  });

  it('notes the outcome on the ticket as an internal comment', async () => {
    await provisionApproved();
    const note = find(/INSERT INTO ticket_comments/)[0];
    expect(note.params[0]).toBe(TICKET_ORG);
    expect(note.params[1]).toBe(TICKET);
    expect(String(note.params[3])).toMatch(/^Provisioning run succeeded: /);
  });
});

describe('listCloudPcPolicies scoping', () => {
  it('scopes ticket.create to the organization that owns the provisioning tenant', async () => {
    const TENANT_ORG = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    h.setDbRows((text) => (/FROM organizations WHERE entra_tenant_id/.test(text) ? [{ id: TENANT_ORG }] : []));
    g.cloudPc.get.mockImplementation(async () => ({ value: [{ id: 'p1', displayName: 'SBSFederal Cloud PC' }] }));
    expect(await provisioning.listCloudPcPolicies(actor)).toEqual(['SBSFederal Cloud PC']);
    expect(h.authorize).toHaveBeenCalledWith(actor, 'ticket.create', { organizationId: TENANT_ORG });
  });

  it('lists nothing, and calls no tenant, when no organization claims the tenant', async () => {
    h.setDbRows(() => []);
    expect(await provisioning.listCloudPcPolicies(actor)).toEqual([]);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 1 — the preview guarantee is BOUND, not merely shared
// ---------------------------------------------------------------------------
describe('binding an execute to the plan that was previewed', () => {
  it('refuses an execute with no fingerprint — silence is not consent', async () => {
    await expect(provisioning.provision(actor, TICKET)).rejects.toThrow(/fingerprint is required/);
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses an execute with an empty fingerprint', async () => {
    await expect(provisioning.provision(actor, TICKET, '')).rejects.toThrow(/fingerprint is required/);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('refuses a fingerprint that was never issued', async () => {
    await expect(provisioning.provision(actor, TICKET, 'deadbeef')).rejects.toMatchObject({ status: 412 });
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  // THE DEFECT, reproduced. The admin previews a plan for ada.lovelace with one group; the
  // ticket's answers are then edited; the previously-approved click now creates a DIFFERENT
  // federal identity with a different group list. Before the binding this succeeded silently.
  it('refuses when the ticket answers changed between preview and execute', async () => {
    const approved = await provisioning.preview(actor, TICKET);
    expect(approved.upn).toBe('ada.lovelace@sbsfederal.com');

    h.setDbRows((text, params) => {
      if (/FROM tickets WHERE id/.test(text)) {
        return [{
          id: TICKET, organization_id: TICKET_ORG, category: 'user.provisioning',
          custom_fields: { ...ANSWERS, legal_last_name: 'Byron', security_groups: 'All Staff, Finance' },
        }];
      }
      return defaultRows()(text, params);
    });
    h.queries.length = 0;

    const err: any = await provisioning.provision(actor, TICKET, approved.fingerprint).catch((e) => e);
    expect(err.status).toBe(412);
    expect(err.detail).toMatch(/changed since it was previewed/);
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();   // no identity created
    expect(h.audit).not.toHaveBeenCalled();
  });

  // The same class of drift, but on the TENANT side rather than the ticket: the previewed plan
  // resolved "All Staff" to g1, and by execute time the name resolves to a different object.
  it('refuses when a resolved group id changed under the same name', async () => {
    const approved = await provisioning.preview(actor, TICKET);
    g = graphDouble({ groups: [{ id: 'g-different', displayName: 'All Staff' }] });
    h.queries.length = 0;

    await expect(provisioning.provision(actor, TICKET, approved.fingerprint))
      .rejects.toMatchObject({ status: 412 });
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('proceeds when the plan is unchanged', async () => {
    const r = await provisionApproved();
    expect(r.status).toBe('succeeded');
  });

  // 412, not 409: the panel has to tell "your approval is stale, preview again" apart from
  // "a run is already in progress, wait", and both would otherwise be a bare Conflict.
  it('reports a stale approval distinctly from an in-flight run', async () => {
    const stale: any = await provisioning.provision(actor, TICKET, 'not-the-plan').catch((e) => e);
    h.setDbRows(defaultRows({ runInsert: [] }));
    const inFlight: any = await provisionApproved().catch((e) => e);
    expect(stale.status).toBe(412);
    expect(inFlight.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 6 — the approval gate, server-side
// ---------------------------------------------------------------------------
describe('the human-in-the-loop gate is enforced by the server', () => {
  /** Preview always succeeds here, so each refusal below is provably the gate and not the plan. */
  async function executeWithCurrentPlan() {
    const plan = await provisioning.preview(actor, TICKET);
    h.queries.length = 0;
    return provisioning.provision(actor, TICKET, plan.fingerprint);
  }

  it('refuses a ticket whose approval is still outstanding', async () => {
    h.setDbRows(defaultRows({ approvals: [{ status: 'requested' }] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/every approval to be approved/);
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('refuses a ticket whose approval was REJECTED', async () => {
    h.setDbRows(defaultRows({ approvals: [{ status: 'rejected' }] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/every approval to be approved/);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('refuses when one of several approvals is not approved', async () => {
    h.setDbRows(defaultRows({ approvals: [{ status: 'approved' }, { status: 'requested' }] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/every approval to be approved/);
  });

  // The client's rule was the opposite: it treated "no approvals" as passed. The catalog item
  // is requires_approval, so a ticket with no approval record did not come through this intake.
  it('refuses a ticket with NO approval record at all', async () => {
    h.setDbRows(defaultRows({ approvals: [] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/no approval record/);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('refuses a ticket that is not a user.provisioning catalog request', async () => {
    h.setDbRows(defaultRows({ ticketCategory: 'incident.general' }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/user\.provisioning catalog request/);
    expect(g.graph.post).not.toHaveBeenCalled();
  });

  it('refuses a ticket with no catalog category at all', async () => {
    h.setDbRows(defaultRows({ ticketCategory: null, catalogItem: [] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/user\.provisioning catalog request/);
  });

  it('refuses when the catalog item no longer carries a form', async () => {
    h.setDbRows(defaultRows({ catalogItem: [{ key: 'user.provisioning', form_key: null }] }));
    await expect(executeWithCurrentPlan()).rejects.toThrow(/user\.provisioning catalog request/);
  });

  it('lets an approved onboarding request through', async () => {
    await expect(executeWithCurrentPlan()).resolves.toMatchObject({ status: 'succeeded' });
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 3 — writes are bound to the tenant-owning organization
// ---------------------------------------------------------------------------
describe('preview and provision are bound to the provisioning tenant organization', () => {
  it('refuses a ticket in some OTHER organization', async () => {
    const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    h.setDbRows(defaultRows({ ticketOrg: OTHER }));
    await expect(provisioning.preview(actor, TICKET)).rejects.toThrow(/owns the provisioning tenant/);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });

  it('refuses to write from a ticket in some OTHER organization', async () => {
    const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    h.setDbRows(defaultRows({ ticketOrg: OTHER }));
    await expect(provisioning.provision(actor, TICKET, 'anything')).rejects.toThrow(/owns the provisioning tenant/);
    expect(find(/INSERT INTO provisioning_runs/)).toHaveLength(0);
  });

  it('refuses when no organization claims the tenant, rather than provisioning anyway', async () => {
    h.setDbRows(defaultRows({ tenantOrgRows: [] }));
    await expect(provisioning.preview(actor, TICKET)).rejects.toThrow(/no organization is mapped/);
    expect(h.getProvisioningGraph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 3 — the supervisor lookup is scoped
// ---------------------------------------------------------------------------
describe('who may receive a Temporary Access Pass', () => {
  it('scopes the supervisor lookup to the nexus plane AND the ticket organization', async () => {
    await provisionApproved();
    const lookup = find(/FROM users u/)[0];
    expect(lookup).toBeDefined();
    expect(lookup.text).toMatch(/plane = 'nexus'/);
    expect(lookup.text).toMatch(/role_assignments/);
    expect(lookup.params).toEqual([SUPERVISOR, TICKET_ORG]);
  });

  // THE DEFECT. `SELECT email, status FROM users WHERE id = $1` in system context, with a form
  // layer that validates `supervisor` as "any string": a submitted uuid for a user in another
  // organization, or a customer-plane end user, was mailed a live credential for a brand-new
  // federal identity. The scoped query simply does not return them.
  it('refuses to deliver when the submitted supervisor is out of scope', async () => {
    h.setDbRows(defaultRows({ supervisorRows: [] }));
    const r = await provisionApproved();
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.error)
      .toMatch(/not a Nexus platform user scoped to this organization/);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MINOR 8 — the mail call is wrapped, so containment does not rest on one layer
// ---------------------------------------------------------------------------
describe('a mail adapter that throws', () => {
  it('cannot carry the pass out in its error message', async () => {
    h.sendEmail.mockImplementation(async () => {
      // Exactly what a mail adapter that echoes the envelope it failed to send looks like.
      throw new Error(`SMTP 550 rejected message: Pass: ${TAP}`);
    });
    const r = await provisionApproved();

    expect(r.status).toBe('failed');
    const outcome = r.outcomes.find((o) => o.key === 'issue_tap');
    // A FIXED string, the same shape the issueTap wrapper already used — not the adapter's text.
    expect(outcome?.error).toBe('sending the Temporary Access Pass to the supervisor failed');
    expect(JSON.stringify(r)).not.toContain(TAP);
    for (const q of h.queries) expect(JSON.stringify(q.params)).not.toContain(TAP);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 — the skipped TAP has to be unmistakable on the TICKET too
// ---------------------------------------------------------------------------
describe('a run against a tenant with no Temporary Access Pass policy', () => {
  beforeEach(() => {
    g.graph.post.mockImplementation(async (path: string) => {
      if (path.includes('temporaryAccessPassMethods')) {
        throw new GraphError(400, '{"error":{"code":"badRequest","message":"Temporary Access Pass is not enabled for the tenant."}}');
      }
      if (path === '/users') return { id: 'u-new' };
      return {};
    });
  });

  it('succeeds with issue_tap skipped rather than failing after the account exists', async () => {
    const r = await provisionApproved();
    expect(r.status).toBe('succeeded');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.status).toBe('skipped');
    // The account and its licences really were written — which is exactly why failing the run
    // here would have been the wrong answer.
    expect(r.outcomes.find((o) => o.key === 'create_user')?.status).toBe('succeeded');
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('says on the ticket that no credential was delivered', async () => {
    await provisionApproved();
    const note = String(find(/INSERT INTO ticket_comments/)[0].params[3]);
    expect(note).toMatch(/issue_tap=skipped/);
    expect(note).toMatch(/NO CREDENTIAL WAS DELIVERED/);
    expect(note).toMatch(/out of band/);
  });

  it('records the skip on the step row', async () => {
    await provisionApproved();
    const stepUpdate = find(/UPDATE provisioning_steps/).find((q) => q.params[1] === 'issue_tap');
    expect(stepUpdate?.params[2]).toBe('skipped');
    expect(String(stepUpdate?.params[4])).toMatch(/NO CREDENTIAL WAS DELIVERED/);
  });

  // A different Graph 403 is a real failure and must stay one.
  it('still fails the run for an ordinary Graph authorization error', async () => {
    g.graph.post.mockImplementation(async (path: string) => {
      if (path.includes('temporaryAccessPassMethods')) {
        throw new GraphError(403, '{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges."}}');
      }
      if (path === '/users') return { id: 'u-new' };
      return {};
    });
    const r = await provisionApproved();
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.status).toBe('failed');
  });
});
