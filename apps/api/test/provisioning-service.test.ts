// The service layer's pure decision functions, plus the invariant they exist to protect:
// the planner emits group NAMES, the executor consumes group IDs, and the service is the only
// thing that bridges them. These tests deliberately drive the REAL planner and the REAL
// executor around the resolution step rather than hand-rolling a plan object, so a change to
// either side that breaks the seam fails here instead of at 2am against a live GCC High tenant.
import { describe, it, expect } from 'vitest';
import {
  resolveGroupIds,
  applyGroupResolution,
} from '../src/modules/provisioning/index.js';
import { normalizeGroups } from '../src/integrations/m365/provisioning-graph.js';
import { planRun, type Plan } from '../src/modules/provisioning/planner.js';
import { executePlan, type ProvisioningOps } from '../src/modules/provisioning/executor.js';
import type { TenantState } from '../src/integrations/m365/provisioning-graph.js';

const directory = [
  { id: 'g1', displayName: 'All Staff' },
  { id: 'g2', displayName: 'Engineering' },
];

const tenant: TenantState = {
  skus: [{ skuId: 'sku-e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 1 }],
  policies: [],
};

/** A plan straight out of the real (pure) planner, with group names but no ids yet. */
function plannedRun(securityGroups: string): Plan {
  return planRun({
    answers: {
      legal_first_name: 'Ada',
      legal_last_name: 'Lovelace',
      security_groups: securityGroups,
      supervisor: '11111111-1111-1111-1111-111111111111',
    },
    tenant,
    upnDomain: 'sbsfederal.com',
    baselineSkus: ['SPE_E3_USGOV_GCCHIGH'],
    existingUser: null,
    existingRoleCount: 0,
  });
}

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

describe('resolveGroupIds', () => {
  it('maps group names to ids', () => {
    expect(resolveGroupIds(['All Staff', 'Engineering'], directory))
      .toEqual({ groupIds: ['g1', 'g2'], missing: [] });
  });

  it('reports names that do not resolve rather than silently dropping them', () => {
    expect(resolveGroupIds(['All Staff', 'Ghost'], directory))
      .toEqual({ groupIds: ['g1'], missing: ['Ghost'] });
  });

  it('is case-insensitive', () => {
    expect(resolveGroupIds(['all staff'], directory).groupIds).toEqual(['g1']);
  });

  it('ignores surrounding whitespace on the requested name', () => {
    expect(resolveGroupIds(['  Engineering '], directory).groupIds).toEqual(['g2']);
  });

  it('does not add the same group twice when a name repeats', () => {
    expect(resolveGroupIds(['All Staff', 'all staff'], directory))
      .toEqual({ groupIds: ['g1'], missing: [] });
  });
});

describe('normalizeGroups', () => {
  it('reduces a Graph payload to id/displayName pairs', () => {
    expect(normalizeGroups({ value: [{ id: 'g1', displayName: 'All Staff', mailNickname: 'x' }] }))
      .toEqual([{ id: 'g1', displayName: 'All Staff' }]);
  });

  it('tolerates an empty or missing payload', () => {
    expect(normalizeGroups(undefined)).toEqual([]);
    expect(normalizeGroups({})).toEqual([]);
  });

  it('drops entries missing an id or a display name rather than emitting undefined ones', () => {
    expect(normalizeGroups({ value: [{ id: 'g1' }, { displayName: 'No Id' }, { id: 'g2', displayName: 'Ok' }] }))
      .toEqual([{ id: 'g2', displayName: 'Ok' }]);
  });
});

describe('applyGroupResolution (the planner -> executor seam)', () => {
  it('writes detail.groupIds onto the add_groups step the real planner produced', () => {
    const resolved = applyGroupResolution(plannedRun('All Staff, Engineering'), directory);
    const step = resolved.steps.find((s) => s.key === 'add_groups');
    expect(step?.detail.groups).toEqual(['All Staff', 'Engineering']);
    expect(step?.detail.groupIds).toEqual(['g1', 'g2']);
    expect(resolved.blockers).toEqual([]);
  });

  it('does not mutate the plan it was given', () => {
    const plan = plannedRun('All Staff');
    applyGroupResolution(plan, directory);
    expect(plan.steps.find((s) => s.key === 'add_groups')?.detail.groupIds).toBeUndefined();
    expect(plan.blockers).toEqual([]);
  });

  it('turns an unresolved name into a group_missing blocker naming the group', () => {
    const resolved = applyGroupResolution(plannedRun('All Staff, Ghost Group'), directory);
    expect(resolved.blockers).toEqual([
      { code: 'group_missing', message: 'Group "Ghost Group" was not found in the directory.' },
    ]);
    // The names that DID resolve are still recorded — the blocker is what stops the run.
    expect(resolved.steps.find((s) => s.key === 'add_groups')?.detail.groupIds).toEqual(['g1']);
  });

  it('leaves a plan with no group step untouched', () => {
    const plan = plannedRun('');
    expect(plan.steps.some((s) => s.key === 'add_groups')).toBe(false);
    expect(applyGroupResolution(plan, directory)).toEqual(plan);
  });

  // --- The invariant, checked end to end against the real executor ---

  it('produces a plan the executor accepts, adding the user to exactly the resolved ids', async () => {
    const added: string[] = [];
    const r = await executePlan(
      applyGroupResolution(plannedRun('All Staff, Engineering'), directory),
      ops({ addToGroup: async (groupId) => { added.push(groupId); return {}; } }),
    );
    expect(r.status).toBe('succeeded');
    expect(added).toEqual(['g1', 'g2']);
    expect(r.outcomes.find((o) => o.key === 'add_groups')?.status).toBe('succeeded');
  });

  it('is load-bearing: an unresolved plan is refused by the executor', async () => {
    // This is the failure the seam exists to prevent. If applyGroupResolution ever stops
    // writing groupIds, THIS is what production does.
    const r = await executePlan(plannedRun('All Staff'), ops());
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'add_groups')?.error).toMatch(/groupIds/);
  });

  it('blocks execution entirely when a name did not resolve', async () => {
    await expect(executePlan(applyGroupResolution(plannedRun('Ghost Group'), directory), ops()))
      .rejects.toThrow(/blocker/);
  });
});
