import { describe, it, expect } from 'vitest';
import { deriveUpn, planRun } from '../src/modules/provisioning/planner.js';

const tenant = {
  skus: [
    { skuId: 'e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 2 },
    { skuId: 'mde', skuPartNumber: 'MDATP_XPLAT', enabled: 10, consumed: 2 },
  ],
  policies: [{ id: 'p1', displayName: 'SBSFederal Cloud PC', groupIds: ['g-cloudpc'] }],
};

const answers = {
  legal_first_name: 'Ada', legal_last_name: 'Lovelace',
  work_location: 'On Site', cloud_pc_policy: 'SBSFederal Cloud PC',
  security_groups: 'All Staff', supervisor: 'sup-1',
};

const base = {
  answers, tenant, upnDomain: 'sbsfederal.com',
  baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT'],
  existingUser: null, existingRoleCount: 0,
};

describe('deriveUpn', () => {
  it('builds first.last at the configured domain, lowercased', () => {
    expect(deriveUpn(answers, 'sbsfederal.com')).toBe('ada.lovelace@sbsfederal.com');
  });
  it('prefers the preferred first name when present', () => {
    expect(deriveUpn({ ...answers, preferred_first_name: 'Addy' }, 'sbsfederal.com'))
      .toBe('addy.lovelace@sbsfederal.com');
  });
  it('strips characters that are invalid in a UPN', () => {
    expect(deriveUpn({ legal_first_name: "D'Arcy", legal_last_name: 'Van Berg' }, 'sbsfederal.com'))
      .toBe('darcy.vanberg@sbsfederal.com');
  });
});

describe('planRun', () => {
  it('orders licences before the Cloud PC group assignment', () => {
    const keys = planRun(base).steps.map((s) => s.key);
    expect(keys.indexOf('assign_licenses')).toBeLessThan(keys.indexOf('assign_cloudpc'));
    expect(keys).toContain('await_cloudpc');
  });

  it('has no blockers for a clean request', () => {
    expect(planRun(base).blockers).toEqual([]);
  });

  it('blocks when a baseline SKU is absent from the tenant', () => {
    const p = planRun({ ...base, baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'NOT_PRESENT'] });
    expect(p.blockers.map((b) => b.code)).toContain('sku_missing');
  });

  it('blocks when a baseline SKU has no seats left', () => {
    const p = planRun({ ...base, tenant: { ...tenant,
      skus: [{ skuId: 'e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 2, consumed: 2 },
             { skuId: 'mde', skuPartNumber: 'MDATP_XPLAT', enabled: 10, consumed: 2 }] } });
    expect(p.blockers.map((b) => b.code)).toContain('no_seats');
  });

  it('blocks when the named Cloud PC policy does not exist', () => {
    const p = planRun({ ...base, answers: { ...answers, cloud_pc_policy: 'Nope' } });
    expect(p.blockers.map((b) => b.code)).toContain('policy_missing');
  });

  it('blocks when the UPN belongs to a privileged account', () => {
    const p = planRun({ ...base, existingUser: { id: 'u1', userPrincipalName: 'ada.lovelace@sbsfederal.com' }, existingRoleCount: 1 });
    expect(p.blockers.map((b) => b.code)).toContain('privileged_account');
  });

  it('omits Cloud PC steps when no policy was requested', () => {
    const p = planRun({ ...base, answers: { ...answers, cloud_pc_policy: '' } });
    expect(p.steps.map((s) => s.key)).not.toContain('assign_cloudpc');
    expect(p.steps.map((s) => s.key)).not.toContain('await_cloudpc');
  });

  // --- Additional cases beyond the brief's nine, added during this task ---

  it('leaves group names (not resolved IDs) in add_groups.detail for the service layer to resolve', () => {
    const p = planRun(base);
    const step = p.steps.find((s) => s.key === 'add_groups');
    expect(step?.detail.groups).toEqual(['All Staff']);
    expect(step?.detail.groupIds).toBeUndefined();
  });

  it('blocks when the named Cloud PC policy exists but has no assignment group', () => {
    const p = planRun({ ...base, tenant: { ...tenant,
      policies: [{ id: 'p1', displayName: 'SBSFederal Cloud PC', groupIds: [] }] } });
    expect(p.blockers.map((b) => b.code)).toContain('policy_unassigned');
  });

  it('does not treat an existing non-privileged account as a blocker (adopts it instead)', () => {
    const p = planRun({ ...base, existingUser: { id: 'u1', userPrincipalName: 'ada.lovelace@sbsfederal.com' }, existingRoleCount: 0 });
    expect(p.blockers).toEqual([]);
    const step = p.steps.find((s) => s.key === 'create_user');
    expect(step?.detail.adopting).toBe(true);
  });

  it('is a pure function: identical input produces a deep-equal plan on repeated calls', () => {
    const a = planRun(base);
    const b = planRun(base);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
