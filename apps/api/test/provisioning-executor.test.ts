import { describe, it, expect } from 'vitest';
import { executePlan, type ProvisioningOps } from '../src/modules/provisioning/executor.js';
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
});
