import { describe, it, expect } from 'vitest';
import {
  executePlan, TapPolicyUnavailableError, TAP_SKIPPED_NOTICE,
  type ProvisioningOps,
} from '../src/modules/provisioning/executor.js';
import type { Plan } from '../src/modules/provisioning/planner.js';

const plan: Plan = {
  upn: 'ada.lovelace@sbsfederal.com', displayName: 'Ada Lovelace', blockers: [],
  steps: [
    { key: 'create_user', label: '', detail: { upn: 'ada.lovelace@sbsfederal.com', displayName: 'Ada Lovelace', adopting: false } },
    { key: 'assign_licenses', label: '', detail: { skuIds: ['e3'] } },
    { key: 'assign_cloudpc', label: '', detail: { groupId: 'g-cloudpc' } },
    { key: 'issue_tap', label: '', detail: {} },
    { key: 'await_cloudpc', label: '', detail: {} },
  ],
};

function ops(over: Partial<ProvisioningOps> = {}): ProvisioningOps {
  return {
    findUser: async () => null,
    createUser: async () => ({ id: 'u1' }),
    currentLicenses: async () => [],
    assignLicenses: async () => ({}),
    addToGroup: async () => ({}),
    issueTap: async () => ({ temporaryAccessPass: 'TAP123' }),
    deliverTap: async () => {},
    ...over,
  };
}

describe('executePlan', () => {
  it('runs the steps in order and rests at awaiting_cloudpc', async () => {
    const r = await executePlan(plan, ops());
    expect(r.status).toBe('awaiting_cloudpc');
    expect(r.outcomes.map((o) => o.key)).toEqual(['create_user', 'assign_licenses', 'assign_cloudpc', 'issue_tap', 'await_cloudpc']);
  });

  it('adopts an existing user instead of creating a duplicate', async () => {
    let created = 0;
    const r = await executePlan(plan, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: 'ada.lovelace@sbsfederal.com' }),
      createUser: async () => { created += 1; return { id: 'new' }; },
    }));
    expect(created).toBe(0);
    expect(r.outcomes[0].graphObjectId).toBe('existing');
  });

  it('assigns only the licences the user is missing', async () => {
    let requested: string[] = [];
    await executePlan(plan, ops({
      currentLicenses: async () => ['e3'],
      assignLicenses: async (_id, skuIds) => { requested = skuIds; return {}; },
    }));
    expect(requested).toEqual([]);
  });

  it('assigns exactly the missing delta when some, but not all, licences are already held', async () => {
    const withTwoSkus: Plan = {
      ...plan,
      steps: plan.steps.map((s) => (s.key === 'assign_licenses' ? { ...s, detail: { skuIds: ['e3', 'p1'] } } : s)),
    };
    let requested: string[] = [];
    let calls = 0;
    await executePlan(withTwoSkus, ops({
      currentLicenses: async () => ['e3'],
      assignLicenses: async (_id, skuIds) => { calls += 1; requested = skuIds; return {}; },
    }));
    expect(requested).toEqual(['p1']);
    expect(calls).toBe(1);
  });

  it('stops at the failing step and does not run later ones', async () => {
    const r = await executePlan(plan, ops({
      assignLicenses: async () => { throw new Error('seat exhausted'); },
    }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'assign_licenses')?.error).toContain('seat exhausted');
    expect(r.outcomes.map((o) => o.key)).not.toContain('assign_cloudpc');
  });

  it('refuses to execute a plan carrying blockers', async () => {
    const blocked = { ...plan, blockers: [{ code: 'no_seats', message: 'No seats remaining.' }] };
    await expect(executePlan(blocked, ops())).rejects.toThrow(/blocker/i);
  });

  // --- Additional coverage beyond the brief ---

  it('refusing a blocked plan performs zero side effects', async () => {
    const blocked = { ...plan, blockers: [{ code: 'no_seats', message: 'No seats remaining.' }] };
    let calls = 0;
    const counting: ProvisioningOps = ops({
      findUser: async () => { calls += 1; return null; },
      createUser: async () => { calls += 1; return { id: 'u1' }; },
    });
    await expect(executePlan(blocked, counting)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('never places the TAP value anywhere in the returned outcomes', async () => {
    const r = await executePlan(plan, ops());
    const serialized = JSON.stringify(r.outcomes);
    expect(serialized).not.toContain('TAP123');
    const issueOutcome = r.outcomes.find((o) => o.key === 'issue_tap');
    expect(issueOutcome).toEqual({ key: 'issue_tap', status: 'succeeded' });
  });

  it('delivers the TAP to the supervisor named in the step detail, not to Graph object ids', async () => {
    const withSupervisor: Plan = {
      ...plan,
      steps: plan.steps.map((s) => (s.key === 'issue_tap' ? { ...s, detail: { supervisor: 'sup-1' } } : s)),
    };
    let delivered: { supervisorId: string; upn: string; pass: string } | undefined;
    await executePlan(withSupervisor, ops({
      deliverTap: async (supervisorId, upn, pass) => { delivered = { supervisorId, upn, pass }; },
    }));
    expect(delivered).toEqual({ supervisorId: 'sup-1', upn: 'ada.lovelace@sbsfederal.com', pass: 'TAP123' });
  });

  it('generates a high-entropy, unique initial password per createUser call and never returns it', async () => {
    const passwords: string[] = [];
    await executePlan(plan, ops({
      createUser: async (body) => {
        const profile = body.passwordProfile as { password: string; forceChangePasswordNextSignIn: boolean };
        passwords.push(profile.password);
        expect(profile.forceChangePasswordNextSignIn).toBe(true);
        return { id: 'u1' };
      },
    }));
    // Run again to confirm passwords are not reused/deterministic across invocations.
    await executePlan(plan, ops({
      createUser: async (body) => {
        const profile = body.passwordProfile as { password: string };
        passwords.push(profile.password);
        return { id: 'u1' };
      },
    }));
    expect(passwords).toHaveLength(2);
    expect(passwords[0]).not.toBe(passwords[1]);
    for (const pw of passwords) {
      expect(pw.length).toBeGreaterThanOrEqual(24);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*]/);
    }
    const outcomes = await executePlan(plan, ops()).then((r) => r.outcomes);
    expect(JSON.stringify(outcomes)).not.toMatch(/Aa1!/);
  });

  it('adds the user to every group id in add_groups, ignoring the planner-only group names seam', async () => {
    const withGroups: Plan = {
      ...plan,
      steps: [
        plan.steps[0],
        { key: 'add_groups', label: '', detail: { groups: ['All Staff'], groupIds: ['g-1', 'g-2'] } },
      ],
    };
    const added: string[] = [];
    const r = await executePlan(withGroups, ops({
      addToGroup: async (groupId) => { added.push(groupId); return {}; },
    }));
    expect(added).toEqual(['g-1', 'g-2']);
    expect(r.status).toBe('succeeded');
  });

  it('returns status succeeded (not awaiting_cloudpc) when the plan has no await_cloudpc step', async () => {
    const noCloudPc: Plan = { ...plan, steps: [plan.steps[0]] };
    const r = await executePlan(noCloudPc, ops());
    expect(r.status).toBe('succeeded');
  });

  it('propagates a non-Error throw as a string error rather than crashing', async () => {
    const r = await executePlan(plan, ops({
      assignLicenses: async () => { throw 'quota service unavailable'; },
    }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'assign_licenses')?.error).toContain('quota service unavailable');
  });

  // --- Fix round 1 ---

  it('redacts the TAP out of a deliverTap failure message instead of letting it reach the outcome', async () => {
    const r = await executePlan(plan, ops({
      issueTap: async () => ({ temporaryAccessPass: 'TAP123' }),
      deliverTap: async () => { throw new Error('smtp rejected: pass=TAP123'); },
    }));
    expect(r.status).toBe('failed');
    const serialized = JSON.stringify(r.outcomes);
    expect(serialized).not.toContain('TAP123');
    const failed = r.outcomes.find((o) => o.key === 'issue_tap');
    expect(failed?.error).toContain('smtp rejected');
    expect(failed?.error).toContain('[redacted]');
  });

  it('redacts the initial password out of a createUser failure message instead of letting it reach the outcome', async () => {
    let capturedPassword = '';
    const r = await executePlan(plan, ops({
      createUser: async (body) => {
        const profile = body.passwordProfile as { password: string };
        capturedPassword = profile.password;
        throw new Error(`invalid password: rejected value "${capturedPassword}"`);
      },
    }));
    expect(r.status).toBe('failed');
    expect(capturedPassword.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(r.outcomes);
    expect(serialized).not.toContain(capturedPassword);
    const failed = r.outcomes.find((o) => o.key === 'create_user');
    expect(failed?.error).toContain('invalid password');
    expect(failed?.error).toContain('[redacted]');
  });

  it('fails add_groups loudly when group names are present but groupIds were never resolved', async () => {
    const unresolved: Plan = {
      ...plan,
      steps: [
        plan.steps[0],
        { key: 'add_groups', label: '', detail: { groups: ['All Staff'] } }, // no groupIds
      ],
    };
    let addToGroupCalls = 0;
    const r = await executePlan(unresolved, ops({
      addToGroup: async (g, u) => { addToGroupCalls += 1; return { g, u }; },
    }));
    expect(r.status).toBe('failed');
    expect(addToGroupCalls).toBe(0);
    expect(r.outcomes.find((o) => o.key === 'add_groups')?.error).toMatch(/groupIds is empty/i);
  });

  it('refuses a step that depends on the user id when create_user never ran', async () => {
    const noCreateUser: Plan = {
      ...plan,
      steps: [{ key: 'assign_licenses', label: '', detail: { skuIds: ['e3'] } }],
    };
    let currentLicensesCalls = 0;
    const r = await executePlan(noCreateUser, ops({
      currentLicenses: async () => { currentLicensesCalls += 1; return []; },
    }));
    expect(r.status).toBe('failed');
    expect(currentLicensesCalls).toBe(0); // failed locally, before any network call
    expect(r.outcomes[0].error).toMatch(/no user id available/i);
  });

  it('rejects an assign_cloudpc step with a missing or non-string groupId before calling Graph', async () => {
    const badGroupId: Plan = {
      ...plan,
      steps: [
        plan.steps[0],
        { key: 'assign_cloudpc', label: '', detail: {} }, // no groupId
      ],
    };
    let addToGroupCalls = 0;
    const r = await executePlan(badGroupId, ops({
      addToGroup: async () => { addToGroupCalls += 1; return {}; },
    }));
    expect(r.status).toBe('failed');
    expect(addToGroupCalls).toBe(0);
    expect(r.outcomes.find((o) => o.key === 'assign_cloudpc')?.error).toMatch(/groupId/i);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 — spec open item #4: "issue_tap is marked skipped and the rest of the run is
// unaffected". There was no skip path at all: issueTap threw and the run failed AFTER the
// account, the licences and the group memberships were already written to a live tenant.
// ---------------------------------------------------------------------------
describe('a tenant with no Temporary Access Pass policy', () => {
  const tapDown = ops({
    issueTap: async () => { throw new TapPolicyUnavailableError(); },
  });

  it('marks issue_tap skipped instead of failing the run', async () => {
    const r = await executePlan(plan, tapDown);
    const tap = r.outcomes.find((o) => o.key === 'issue_tap');
    expect(tap?.status).toBe('skipped');
    expect(r.status).toBe('awaiting_cloudpc'); // i.e. NOT 'failed'
  });

  it('leaves the rest of the run unaffected — later steps still run', async () => {
    const r = await executePlan(plan, tapDown);
    expect(r.outcomes.map((o) => o.key)).toEqual([
      'create_user', 'assign_licenses', 'assign_cloudpc', 'issue_tap', 'await_cloudpc',
    ]);
    expect(r.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
  });

  it('says on the outcome, unmistakably, that no credential was delivered', async () => {
    const r = await executePlan(plan, tapDown);
    const tap = r.outcomes.find((o) => o.key === 'issue_tap');
    expect(tap?.error).toBe(TAP_SKIPPED_NOTICE);
    expect(tap?.error).toMatch(/NO CREDENTIAL WAS DELIVERED/);
    expect(tap?.error).toMatch(/out of band/);
  });

  it('never delivers anything when the pass could not be issued', async () => {
    let delivered = 0;
    await executePlan(plan, ops({
      issueTap: async () => { throw new TapPolicyUnavailableError(); },
      deliverTap: async () => { delivered += 1; },
    }));
    expect(delivered).toBe(0);
  });

  // The skip is for ONE specific tenant state. Every other issue_tap failure must still fail
  // the run — silently "skipping" a delivery failure would report success while the supervisor
  // never received the credential.
  it('does not skip for any other issue_tap failure', async () => {
    const r = await executePlan(plan, ops({
      issueTap: async () => { throw new Error('issuing the Temporary Access Pass failed (Graph 403)'); },
    }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.status).toBe('failed');
  });

  it('does not skip when DELIVERY fails, only when the tenant has no policy', async () => {
    const r = await executePlan(plan, ops({
      deliverTap: async () => { throw new Error('sending the Temporary Access Pass to the supervisor failed'); },
    }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'issue_tap')?.status).toBe('failed');
  });
});

// The planner can now know TAP is off BEFORE anything is written. The executor must honour that
// without calling Graph at all — otherwise the pre-check is decoration and the run still depends
// on regex-matching whatever error text GCC High happens to return.
describe('issue_tap pre-skip', () => {
  const skipPlan: Plan = {
    ...plan,
    steps: plan.steps.map((s) => s.key === 'issue_tap'
      ? { ...s, detail: { supervisor: 'sup-1', willSkip: true, skipReason: 'Temporary Access Pass is disabled in this tenant.' } }
      : s),
  };

  it('skips without ever calling issueTap', async () => {
    let called = false;
    const r = await executePlan(skipPlan, ops({
      issueTap: async () => { called = true; return { temporaryAccessPass: 'TAP123' }; },
    }));
    expect(called).toBe(false);
    const out = r.outcomes.find((o) => o.key === 'issue_tap')!;
    expect(out.status).toBe('skipped');
    expect(String(out.error)).toMatch(/Temporary Access Pass/i);
  });

  it('still runs every other step — a skipped TAP is not a failed run', async () => {
    const r = await executePlan(skipPlan, ops());
    expect(r.status).toBe('awaiting_cloudpc');
    expect(r.outcomes.map((o) => o.key)).toEqual(
      ['create_user', 'assign_licenses', 'assign_cloudpc', 'issue_tap', 'await_cloudpc']);
  });
});

// FOUND IN PRODUCTION, by the first real run. `create_user` succeeded and `assign_licenses` came
// back 400: "License assignment cannot be done for user with invalid usage location." Graph
// refuses assignLicense unless the user has a usageLocation, and nothing in this codebase ever
// set one — so EVERY provisioning run would have died at step 2, leaving a live, unlicensed
// account behind. The tenant's own convention is US (56 of 60 users).
describe('usageLocation is set before licences are assigned', () => {
  const planWithLoc: Plan = {
    ...plan,
    steps: plan.steps.map((s) => s.key === 'create_user'
      ? { ...s, detail: { ...s.detail, usageLocation: 'US' } } : s),
  };

  it('sets usageLocation on a newly created user', async () => {
    let body: any = null;
    await executePlan(planWithLoc, ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body.usageLocation).toBe('US');
  });

  // THE RECOVERY PATH. The account created by the failed production run already exists with a
  // null usageLocation, so a retry ADOPTS it — and adoption skips createUser entirely. Without
  // this, the retry would fail at assign_licenses exactly as the first run did, forever.
  it('back-fills usageLocation when adopting an existing user that has none', async () => {
    const patched: Array<{ id: string; patch: any }> = [];
    await executePlan(planWithLoc, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: null }),
      patchUser: async (id: string, patch: any) => { patched.push({ id, patch }); },
    } as any));
    expect(patched).toEqual([{ id: 'existing', patch: { usageLocation: 'US' } }]);
  });

  it('does not re-patch a user that already has the right usageLocation', async () => {
    let calls = 0;
    await executePlan(planWithLoc, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US' }),
      patchUser: async () => { calls += 1; },
    } as any));
    expect(calls).toBe(0);
  });
});

describe('given name and surname reach Graph', () => {
  const named: Plan = {
    ...plan,
    steps: plan.steps.map((s) => s.key === 'create_user'
      ? { ...s, detail: { ...s.detail, givenName: 'Ada', surname: 'Lovelace', usageLocation: 'US' } } : s),
  };

  it('sets them on a newly created user', async () => {
    let body: any = null;
    await executePlan(named, ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body.givenName).toBe('Ada');
    expect(body.surname).toBe('Lovelace');
  });

  it('back-fills them on an adopted account that has none', async () => {
    const patches: any[] = [];
    await executePlan(named, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US' }),
      patchUser: async (_id: string, patch: any) => { patches.push(patch); },
    } as any));
    expect(patches).toEqual([{ givenName: 'Ada', surname: 'Lovelace' }]);
  });

  // NEVER overwrite a real person's directory record. findUser matches any account with that UPN,
  // not only one this engine made, so adoption must fill gaps and nothing more.
  it('does not overwrite names that already exist on an adopted account', async () => {
    const patches: any[] = [];
    await executePlan(named, ops({
      findUser: async () => ({
        id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US',
        givenName: 'Augusta', surname: 'King',
      }),
      patchUser: async (_id: string, patch: any) => { patches.push(patch); },
    } as any));
    expect(patches).toEqual([]);
  });
});
