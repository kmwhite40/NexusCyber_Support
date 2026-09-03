// The scheduled half of offboarding, and the one place this engine deliberately behaves
// UNLIKE provisioning.
//
// Provisioning refuses a run outright when the rebuilt plan no longer matches the approved
// fingerprint: creating the wrong account is worse than creating nothing. Offboarding inverts
// that, because failing to disable a terminated employee is the dangerous outcome. On drift the
// account is still made safe — sign-in blocked, sessions revoked — and only the steps that touch
// licences, groups or the mailbox are halted for a human.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const RUN = 'run-1';
const ORG = '22222222-2222-2222-2222-222222222222';
const TICKET = '11111111-1111-1111-1111-111111111111';

const h = vi.hoisted(() => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let dbRows: (text: string, params: unknown[]) => any[] = () => [];
  const sql = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rows: dbRows(text, params) };
    },
  };
  const ops = {
    blockSignin: vi.fn(async () => {}),
    revokeSessions: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeLicenses: vi.fn(async () => {}),
    removeFromGroups: vi.fn(async () => {}),
    recordStep: vi.fn(async () => {}),
  };
  return {
    queries, sql, ops,
    setDbRows: (fn: (text: string, params: unknown[]) => any[]) => { dbRows = fn; },
    withSystemContext: vi.fn(async (fn: any) => fn(sql)),
    readOffboardTenantState: vi.fn(),
    buildOffboardOps: vi.fn(async () => ops),
    recordHold: vi.fn(async () => ({ holdId: 'hold-1', retentionClass: 'standard' })),
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, pool: {} }));
vi.mock('../src/modules/offboarding/index.js', () => ({
  readOffboardTenantState: h.readOffboardTenantState,
  buildOffboardOps: h.buildOffboardOps,
}));
vi.mock('../src/modules/retention/index.js', () => ({ recordHold: h.recordHold }));

const { sweepDueOffboardings } = await import('../src/jobs/offboarding-sweeper.js');
const { planOffboard, offboardFingerprint } = await import('../src/modules/offboarding/planner.js');

const STATE = {
  answers: { last_day: '2026-09-02' },
  departingUpn: 'jane.doe@sbsfederal.com',
  user: {
    id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe',
    accountEnabled: true, givenName: 'Jane', surname: 'Doe',
  },
  directoryRoleCount: 0,
  licenseSkuIds: ['sku-e3'],
  groupIds: ['g-1'],
  // No mailbox to convert, so the run can reach the end and we are testing the sweeper rather
  // than the executor's manual-step halt (which has its own tests).
  mailboxType: 'none' as const,
};

const approvedFingerprint = () => offboardFingerprint(planOffboard(STATE));

/** A due run whose stored plan matches what the tenant still looks like. */
function dueRun(fingerprint: string) {
  return (text: string) => {
    if (/needs_review/.test(text) && /started_at </.test(text)) return []; // nothing stranded
    if (/UPDATE provisioning_runs/.test(text) && /RETURNING/.test(text)) {
      return [{ id: RUN, ticket_id: TICKET, organization_id: ORG, plan: { fingerprint } }];
    }
    return [];
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.queries.length = 0;
  h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
  h.readOffboardTenantState.mockImplementation(async () => STATE);
  h.buildOffboardOps.mockImplementation(async () => h.ops);
  h.recordHold.mockImplementation(async () => ({ holdId: 'hold-1', retentionClass: 'standard' }));
  h.setDbRows(dueRun(approvedFingerprint()));
});

describe('claiming due runs', () => {
  it('claims with FOR UPDATE SKIP LOCKED so two sweepers cannot double-execute a termination', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const claim = h.queries.find((q) => /FOR UPDATE SKIP LOCKED/.test(q.text))!;
    expect(claim.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('only claims offboarding runs that are scheduled and already due', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const claim = h.queries.find((q) => /FOR UPDATE SKIP LOCKED/.test(q.text))!;
    expect(claim.text).toContain("kind = 'offboarding'");
    expect(claim.text).toContain("status = 'scheduled'");
    expect(claim.text).toContain('scheduled_for <=');
  });

  it('does nothing when no run is due', async () => {
    h.setDbRows(() => []);
    const out = await sweepDueOffboardings(new Date('2026-09-01T00:00:00Z'));
    expect(out).toEqual({ claimed: 0, executed: 0, needsReview: 0, stranded: 0 });
    expect(h.ops.blockSignin).not.toHaveBeenCalled();
  });
});

describe('a run whose plan still matches', () => {
  it('executes every step and finishes succeeded', async () => {
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.blockSignin).toHaveBeenCalled();
    expect(h.ops.removeLicenses).toHaveBeenCalled();
    expect(h.ops.removeFromGroups).toHaveBeenCalled();
    expect(out.executed).toBe(1);
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    expect(final.params[1]).toBe('succeeded');
  });
});

describe('THE INVERSION: a run whose plan drifted since approval', () => {
  beforeEach(() => { h.setDbRows(dueRun('a-stale-fingerprint-from-approval-time')); });

  it('still blocks sign-in and revokes sessions', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.blockSignin).toHaveBeenCalled();
    expect(h.ops.revokeSessions).toHaveBeenCalled();
  });

  it('halts every step that touches data', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.rename).not.toHaveBeenCalled();
    expect(h.ops.removeLicenses).not.toHaveBeenCalled();
    expect(h.ops.removeFromGroups).not.toHaveBeenCalled();
  });

  it('flags the run needs_review with the reason recorded', async () => {
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(out.needsReview).toBe(1);
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    expect(final.params[1]).toBe('needs_review');
    expect(String(final.params[2])).toMatch(/changed since approval/i);
  });
});

describe('failure handling', () => {
  it('marks the run failed rather than leaving it stuck running', async () => {
    h.readOffboardTenantState.mockRejectedValueOnce(new Error('graph unreachable'));
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    expect(final.params[1]).toBe('failed');
    expect(String(final.params[2])).toMatch(/graph unreachable/);
  });

  it('scopes every status write to the run organization', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    expect(final.params).toContain(ORG);
  });
});

// The inversion is only worth anything if it actually holds. Two ways it did not:
describe('the inversion has to be real', () => {
  it('does not claim success when blocking sign-in actually failed', async () => {
    // Reporting "sign-in blocked and sessions revoked" while the account is still enabled is
    // worse than reporting a failure: it tells the desk the dangerous half is handled.
    h.setDbRows(dueRun('a-stale-fingerprint-from-approval-time'));
    h.ops.blockSignin.mockRejectedValueOnce(new Error('graph 403'));
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    expect(final.params[1]).toBe('failed');
    expect(String(final.params[2])).not.toMatch(/sign-in blocked/i);
    expect(out.needsReview).toBe(0);
  });

  it('still disables the account when the rebuilt plan has picked up a blocker', async () => {
    // e.g. someone edited last_day between approval and the scheduled moment. The plan is no
    // longer executable, but that is precisely NOT a reason to leave a terminated employee
    // signed in — the security steps destroy no data.
    h.readOffboardTenantState.mockImplementation(async () => ({
      ...STATE, answers: { last_day: 'not-a-date' },
    }));
    h.setDbRows(dueRun('whatever-it-was-at-approval'));
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.blockSignin).toHaveBeenCalled();
    expect(h.ops.revokeSessions).toHaveBeenCalled();
    expect(h.ops.removeLicenses).not.toHaveBeenCalled();
  });
});

// A run claimed as 'running' that never finished — the container was restarted mid-execution —
// was invisible forever: the claim query only looks at 'scheduled', so nothing ever revisited it
// and nobody learned the termination had not completed.
describe('runs stranded in running', () => {
  it('surfaces a long-running run for review instead of leaving it invisible', async () => {
    h.setDbRows((text: string) => {
      if (/UPDATE provisioning_runs/.test(text) && /needs_review/.test(text) && /RETURNING/.test(text)) {
        return [{ id: 'stale-1' }];
      }
      return [];
    });
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const reclaim = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /needs_review/.test(q.text))!;
    expect(reclaim).toBeTruthy();
    expect(reclaim.text).toContain("status = 'running'");
    expect(reclaim.text).toContain('started_at <');
    expect(out.stranded).toBe(1);
  });

  it('does NOT silently re-execute a stranded run', async () => {
    // Re-running destructive steps blind is worse than flagging: removeFromGroup on an
    // already-removed membership fails, and a half-finished teardown is exactly the state a
    // human should look at.
    h.setDbRows((text: string) => {
      if (/UPDATE provisioning_runs/.test(text) && /needs_review/.test(text) && /RETURNING/.test(text)) {
        return [{ id: 'stale-1' }];
      }
      return [];
    });
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.blockSignin).not.toHaveBeenCalled();
    expect(h.ops.removeLicenses).not.toHaveBeenCalled();
  });
});

// The retention obligation attaches to a DISABLED ACCOUNT, not to a fully completed run.
// recordHold sat only on the 'succeeded' branch — but any licensed user's run halts at the manual
// mailbox conversion and finishes 'needs_review', and nothing transitions needs_review ->
// succeeded. So for the COMMON departure no hold was ever recorded and the compliance feature
// silently did nothing.
describe('the retention hold follows the disable, not the full run', () => {
  const withMailbox = { ...STATE, mailboxType: 'user' as const, licenseSkuIds: ['sku-e3'] };

  it('records a hold when the run halts at the manual mailbox step', async () => {
    h.readOffboardTenantState.mockImplementation(async () => withMailbox);
    h.setDbRows(dueRun(offboardFingerprint(planOffboard(withMailbox))));
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(out.needsReview).toBe(1);
    expect(h.recordHold).toHaveBeenCalled();
  });

  it('still records a hold on a fully completed run', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.recordHold).toHaveBeenCalled();
  });

  it('does NOT record a hold when the account was never disabled', async () => {
    // Drift halts everything, but if even block_signin failed there is no disabled account and
    // therefore no obligation to record.
    h.setDbRows(dueRun('stale'));
    h.ops.blockSignin.mockRejectedValueOnce(new Error('graph 403'));
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.recordHold).not.toHaveBeenCalled();
  });
});

describe('the drift failure message says what actually happened', () => {
  it('does not claim the account is unsecured when only session revocation failed', async () => {
    // "the account could not be secured" while block_signin SUCCEEDED tells the desk the account
    // is still enabled when it is disabled — and a retention hold has already been recorded
    // against it. The opposite of the mistake, and just as misleading.
    h.setDbRows(dueRun('stale-fingerprint'));
    h.ops.revokeSessions.mockRejectedValueOnce(new Error('graph 503'));
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const final = h.queries.filter((q) => /SET status = \$2/.test(q.text)).pop()!;
    const msg = String(final.params[2]);
    expect(msg).toMatch(/sign-in was blocked/i);
    expect(msg).toMatch(/revoke_sessions/);
    expect(msg).not.toMatch(/could not be secured/i);
  });
});
