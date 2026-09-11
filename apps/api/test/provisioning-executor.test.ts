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
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: null, passwordProfile: { forceChangePasswordNextSignIn: false } }),
      patchUser: async (id: string, patch: any) => { patched.push({ id, patch }); },
    } as any));
    expect(patched).toEqual([{ id: 'existing', patch: { usageLocation: 'US' } }]);
  });

  it('does not re-patch a user that already has the right usageLocation', async () => {
    let calls = 0;
    await executePlan(planWithLoc, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US', passwordProfile: { forceChangePasswordNextSignIn: false } }),
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
      findUser: async () => ({ id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US', passwordProfile: { forceChangePasswordNextSignIn: false } }),
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
        passwordProfile: { forceChangePasswordNextSignIn: false },
        id: 'existing', userPrincipalName: plan.upn, usageLocation: 'US',
        givenName: 'Augusta', surname: 'King',
      }),
      patchUser: async (_id: string, patch: any) => { patches.push(patch); },
    } as any));
    expect(patches).toEqual([]);
  });
});

// "Most of the fields were not automatically populated under a user profile." The account was
// created with a name and nothing else, because the create body listed seven properties and the
// rest of the intake never travelled with the plan.
describe('the profile attributes on the created account', () => {
  const attributes = { jobTitle: 'Analyst', department: 'Engineering', officeLocation: 'Chantilly, VA' };
  const withAttrs: Plan = {
    ...plan,
    steps: plan.steps.map((s) => (s.key === 'create_user' ? { ...s, detail: { ...s.detail, attributes } } : s)),
  };

  it('sends them to Graph on create', async () => {
    let body: any;
    await executePlan(withAttrs, ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body).toMatchObject(attributes);
    // The identity fields are still there — the attributes are additive, not a replacement.
    expect(body.userPrincipalName).toBe('ada.lovelace@sbsfederal.com');
    expect(body.accountEnabled).toBe(true);
  });

  // findUser matches ANY account with this UPN, not only one this engine created. Adoption fills
  // gaps; it must never overwrite a real person's directory record with a form answer.
  it('fills only the gaps when adopting an existing account', async () => {
    let patch: any;
    await executePlan(withAttrs, ops({
      findUser: async () => ({
        id: 'existing', userPrincipalName: 'ada.lovelace@sbsfederal.com',
        jobTitle: 'Principal Engineer', department: null,
      }) as any,
      patchUser: async (_id: string, p: any) => { patch = p; return {}; },
    }));
    expect(patch.department).toBe('Engineering');
    expect(patch.officeLocation).toBe('Chantilly, VA');
    expect('jobTitle' in patch).toBe(false); // already set on the real account — left alone
  });
});

describe('set_manager', () => {
  const withManager: Plan = {
    ...plan,
    steps: [
      plan.steps[0],
      { key: 'set_manager', label: '', detail: { managerObjectId: 'mgr-oid', managerUpn: 'pat.lee@sbsfederal.com' } },
      ...plan.steps.slice(1),
    ],
  };

  it('writes the manager relationship against the account just created', async () => {
    const calls: Array<[string, string]> = [];
    const r = await executePlan(withManager, ops({
      setManager: async (userId: string, managerId: string) => { calls.push([userId, managerId]); },
    }));
    expect(calls).toEqual([['u1', 'mgr-oid']]);
    expect(r.outcomes.find((o) => o.key === 'set_manager')?.status).toBe('succeeded');
  });

  // The planner only emits this step once the caller has resolved the supervisor, so an
  // unresolved id here means the resolution pass did not run. Reporting "succeeded" while the
  // account quietly has no manager is the failure mode this guards — same reasoning as add_groups.
  it('refuses to report success when the manager id is missing', async () => {
    const broken: Plan = {
      ...withManager,
      steps: withManager.steps.map((s) => (s.key === 'set_manager' ? { ...s, detail: {} } : s)),
    };
    const r = await executePlan(broken, ops({ setManager: async () => {} }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'set_manager')?.error).toMatch(/managerObjectId/);
  });
});

// The account's password is generated, sent to Graph and discarded unread. Demanding a change of
// it at next sign-in asks the new starter for a value nobody has — which is what "the password is
// invalid on first use" was: the pass typed into a current-password field it could never satisfy.
describe('the password change prompt on a new account', () => {
  const withFlag = (forceChangePassword: boolean): Plan => ({
    ...plan,
    steps: plan.steps.map((s) => (s.key === 'create_user' ? { ...s, detail: { ...s.detail, forceChangePassword } } : s)),
  });

  it('does not demand a change when a Temporary Access Pass is the way in', async () => {
    let body: any;
    await executePlan(withFlag(false), ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(false);
    // The password itself is still random and still never returned to anyone.
    expect(typeof body.passwordProfile.password).toBe('string');
    expect(body.passwordProfile.password.length).toBeGreaterThan(15);
  });

  it('demands one when an admin sets the credential out of band instead', async () => {
    let body: any;
    await executePlan(withFlag(true), ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
  });

  // A plan from before the flag existed must not silently start forcing a change again. The pass
  // is the normal path, so the safe default is the one that lets a new starter sign in.
  it('defaults to not demanding a change when the plan does not say', async () => {
    let body: any;
    await executePlan(plan, ops({ createUser: async (b: any) => { body = b; return { id: 'u1' }; } }));
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(false);
  });
});

// The temporary-password alternative. Everything the TAP path does to keep a live credential out
// of step rows, ticket notes and error text has to hold here too — the value is the same kind of
// thing, and outcomes are exactly the sort of structure that ends up on a ticket.
describe('set_password', () => {
  const pwPlan: Plan = {
    ...plan,
    steps: [
      plan.steps[0],
      { key: 'set_password', label: '', detail: { supervisor: 'sup-1' } },
      ...plan.steps.slice(1).filter((s) => s.key !== 'issue_tap'),
    ],
  };
  const pwOps = (over: Partial<ProvisioningOps> = {}) => ops({
    setPassword: async () => {},
    deliverPassword: async () => ({ recipient: 'sup@sbsfederal.com' }),
    ...over,
  });

  it('sets a password on the account and sends it to the supervisor', async () => {
    let set: string | undefined;
    let sent: string | undefined;
    const r = await executePlan(pwPlan, pwOps({
      setPassword: async (_id: string, pw: string) => { set = pw; },
      deliverPassword: async (_sup: string, _upn: string, pw: string) => { sent = pw; return { recipient: 'sup@x' }; },
    }));
    expect(r.outcomes.find((o) => o.key === 'set_password')?.status).toBe('succeeded');
    expect(set).toBeTruthy();
    expect(sent).toBe(set); // the value delivered is the value that was set
    expect(set!.length).toBeGreaterThan(15);
  });

  // Generated per run, never reused, never derived from anything on the request.
  it('mints a different password every time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await executePlan(pwPlan, pwOps({ setPassword: async (_id: string, pw: string) => { seen.add(pw); } }));
    }
    expect(seen.size).toBe(5);
  });

  it('keeps the password out of the outcomes, whatever happens', async () => {
    let minted = '';
    const r = await executePlan(pwPlan, pwOps({
      setPassword: async (_id: string, pw: string) => { minted = pw; },
      // A mail adapter that echoes the message it failed to send — the message body IS the value.
      deliverPassword: async (_s: string, _u: string, pw: string) => { throw new Error(`SMTP 550: ${pw}`); },
    }));
    expect(r.status).toBe('failed');
    expect(minted).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(minted);
  });

  it('does not leak it through a failure to set it either', async () => {
    let minted = '';
    const r = await executePlan(pwPlan, pwOps({
      setPassword: async (_id: string, pw: string) => { minted = pw; throw new Error(`Graph rejected: ${pw}`); },
    }));
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).not.toContain(minted);
  });

  // The ticket has to be able to say a credential was handed over, and to whom — never what.
  it('records who received it, and not the value', async () => {
    let minted = '';
    const r = await executePlan(pwPlan, pwOps({
      setPassword: async (_id: string, pw: string) => { minted = pw; },
    }));
    const out = r.outcomes.find((o) => o.key === 'set_password')!;
    expect(out.note).toMatch(/sup@sbsfederal\.com/);
    expect(JSON.stringify(out)).not.toContain(minted);
  });
});

// Accounts created BEFORE the force-change fix are still broken, and re-running does not repair
// them: adoption fills gaps and deliberately overwrites nothing, so the account keeps demanding a
// password change that the pass it is about to be handed cannot satisfy. A fresh pass alone just
// reproduces "the password is invalid on first use".
//
// The rule is narrow and follows from what the run is doing: if this run is handing the account a
// first-sign-in credential, the account must not demand a password change that credential cannot
// answer. That is the only case the flag is touched — an adopted account in a run that issues no
// credential is left exactly as it was found.
describe('adopting an account that was left demanding a password change', () => {
  const adopt = (over: Record<string, unknown>) => ({
    ...plan,
    steps: plan.steps.map((s) => (s.key === 'create_user' ? { ...s, detail: { ...s.detail, ...over } } : s)),
  });
  const existing = (extra: Record<string, unknown> = {}) => async () => ({
    id: 'existing', userPrincipalName: 'ada.lovelace@sbsfederal.com', ...extra,
  });

  it('clears the demand so the pass it is about to issue can actually be used', async () => {
    let patch: any;
    await executePlan(adopt({ forceChangePassword: false }), ops({
      findUser: existing() as any,
      patchUser: async (_id: string, p: any) => { patch = p; return {}; },
    }));
    expect(patch.passwordProfile).toEqual({ forceChangePasswordNextSignIn: false });
  });

  // A run whose plan says the admin sets the credential out of band must leave the demand alone —
  // there, a forced change at next sign-in is the correct and intended state.
  it('leaves it alone when no credential is being issued', async () => {
    let patch: any = {};
    await executePlan(adopt({ forceChangePassword: true }), ops({
      findUser: existing() as any,
      patchUser: async (_id: string, p: any) => { patch = p; return {}; },
    }));
    expect(patch.passwordProfile).toBeUndefined();
  });

  // passwordProfile cannot be read back from Graph — naming it in a $select makes Graph refuse
  // the whole request with 403 — so this write happens on every adoption that issues a
  // credential, rather than only on the ones that need it. A redundant write costs nothing; a
  // stale demand left in place breaks the credential.
  it('writes it even though the current state cannot be read', async () => {
    let patch: any;
    await executePlan(adopt({ forceChangePassword: false, usageLocation: '', givenName: '', surname: '' }), ops({
      findUser: existing() as any,
      patchUser: async (_id: string, p: any) => { patch = p; return {}; },
    }));
    expect(patch).toEqual({ passwordProfile: { forceChangePasswordNextSignIn: false } });
  });
});
