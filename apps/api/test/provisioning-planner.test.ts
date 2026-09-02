import { describe, it, expect } from 'vitest';
import { deriveUpn, planRun, planFingerprint, normalizeForMatch } from '../src/modules/provisioning/planner.js';

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

// ---------------------------------------------------------------------------
// The real landmine: a ZERO WIDTH SPACE (U+200B) probed live on the SBS Federal GCC High
// tenant's /subscribedSkus response for the Windows 365 Cloud PC SKU
// (skuId 6bd7db5d-58d9-4ab9-b240-114e5f0d2e00), sitting between `64GB` and `_USGOV`. No
// operator can type that character, so the typed form below is what a human would actually put
// in M365_PROV_BASELINE_SKUS, and the tenant form below (with the ZWSP at index 17) is what
// /subscribedSkus actually returns. Both strings are used verbatim, not a stand-in example.
// ---------------------------------------------------------------------------
const CPC_TYPED = 'CPC_E_2C_4GB_64GB_USGOV_GCCHIGH';
const CPC_TENANT = 'CPC_E_2C_4GB_64GB\u200B_USGOV_GCCHIGH';

describe('normalizeForMatch', () => {
  it('the typed form and the tenant form are NOT equal as plain strings (the bug this fixes)', () => {
    expect(CPC_TYPED).not.toBe(CPC_TENANT);
    expect(CPC_TENANT.length).toBe(CPC_TYPED.length + 1);
    expect(CPC_TENANT.charCodeAt(17)).toBe(0x200b);
  });

  it('normalizes the real tenant string and the typed string to the same value', () => {
    expect(normalizeForMatch(CPC_TENANT)).toBe(normalizeForMatch(CPC_TYPED));
  });

  it('strips U+200C, U+200D and U+FEFF too, not just U+200B', () => {
    expect(normalizeForMatch('A\u200Cb\u200Dc\uFEFFd')).toBe('abcd');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeForMatch('  SPE_E3_USGOV_GCCHIGH  ')).toBe('spe_e3_usgov_gcchigh');
  });

  it('is case-insensitive', () => {
    expect(normalizeForMatch('Spe_E3_Usgov_Gcchigh')).toBe('spe_e3_usgov_gcchigh');
  });

  it('does not fold two genuinely different identifiers to the same value', () => {
    expect(normalizeForMatch('SPE_E3_USGOV_GCCHIGH')).not.toBe(normalizeForMatch('MDATP_XPLAT'));
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

  // --- The live-tenant landmine, run through planRun end to end ---
  //
  // /subscribedSkus returns CPC_TENANT (ZWSP and all) as this SKU's real skuPartNumber; an
  // operator configuring M365_PROV_BASELINE_SKUS can only ever type CPC_TYPED. Before this fix,
  // `tenant.skus.find((s) => s.skuPartNumber === part)` never matched the two, and a SKU that
  // IS present in the tenant produced a false sku_missing blocker.
  it('resolves the real tenant SKU (zero-width space and all) against the typed config value', () => {
    const cpcTenant = { skuId: '6bd7db5d-58d9-4ab9-b240-114e5f0d2e00', skuPartNumber: CPC_TENANT, enabled: 10, consumed: 8 };
    const p = planRun({
      ...base,
      tenant: { ...tenant, skus: [...tenant.skus, cpcTenant] },
      baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT', CPC_TYPED],
    });
    expect(p.blockers.map((b) => b.code)).not.toContain('sku_missing');
    const step = p.steps.find((s) => s.key === 'assign_licenses');
    expect(step?.detail.skuIds).toContain(cpcTenant.skuId);
    // The tenant's real value (with the ZWSP) is never rewritten anywhere in the plan.
    expect((step?.detail.skuPartNumbers as string[]).includes(CPC_TYPED)).toBe(true);
  });

  it('still blocks a SKU that is genuinely absent even once zero-width normalisation is applied', () => {
    const cpcTenant = { skuId: '6bd7db5d-58d9-4ab9-b240-114e5f0d2e00', skuPartNumber: CPC_TENANT, enabled: 10, consumed: 8 };
    const p = planRun({
      ...base,
      tenant: { ...tenant, skus: [...tenant.skus, cpcTenant] },
      baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT', 'COMPLETELY_DIFFERENT_SKU'],
    });
    expect(p.blockers).toEqual([{ code: 'sku_missing', message: 'License COMPLETELY_DIFFERENT_SKU is not present in the tenant.' }]);
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

  // The Cloud PC policy displayName match goes through the same normalizeForMatch as the SKU
  // match above, for the same reason: it is tenant/admin data, not something this planner
  // controls, and a stray zero-width character or casing difference must not turn a policy
  // that IS present into a false policy_missing blocker.
  it('resolves the Cloud PC policy through a zero-width space in the tenant displayName', () => {
    const p = planRun({
      ...base,
      tenant: { ...tenant, policies: [{ id: 'p1', displayName: 'SBSFederal\u200B Cloud PC', groupIds: ['g-cloudpc'] }] },
    });
    expect(p.blockers.map((b) => b.code)).not.toContain('policy_missing');
    expect(p.steps.map((s) => s.key)).toContain('assign_cloudpc');
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

  // --- Fix round 1: a CJK/punctuation-only name reduces to an empty slug, which must block
  // rather than silently plan to create "@sbsfederal.com" or ".@sbsfederal.com". ---

  it('blocks a CJK name that reduces to an empty UPN local part', () => {
    const p = planRun({ ...base, answers: { ...answers, legal_first_name: '李', legal_last_name: '明' } });
    expect(p.blockers.map((b) => b.code)).toContain('upn_local_part_empty');
  });

  it('blocks a punctuation-only name that reduces to an empty UPN local part', () => {
    const p = planRun({ ...base, answers: { ...answers, legal_first_name: '...', legal_last_name: '---' } });
    expect(p.blockers.map((b) => b.code)).toContain('upn_local_part_empty');
  });

  it('still derives a valid UPN for a diacritic name (stripping, not blocking)', () => {
    const p = planRun({ ...base, answers: { ...answers, legal_first_name: 'Renée', legal_last_name: 'Dupont' } });
    expect(p.upn).toBe('rene.dupont@sbsfederal.com');
    expect(p.blockers).toEqual([]);
  });

  it("does not alias the caller's baselineSkus array into the returned Plan", () => {
    const p = planRun(base);
    const step = p.steps.find((s) => s.key === 'assign_licenses');
    expect(step?.detail.skuPartNumbers).not.toBe(base.baselineSkus);
    expect(step?.detail.skuPartNumbers).toEqual(base.baselineSkus);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 2 — an empty baseline must be VISIBLE in the dry run, not silent
// ---------------------------------------------------------------------------
describe('an empty licence baseline', () => {
  // Without the blocker: the licence loop has nothing to iterate, so it emits no blocker and
  // no sku id. The plan then reads as perfectly healthy while `assign_licenses` no-ops and
  // `assign_cloudpc` still adds the account to the Cloud PC policy group — a live, unlicensed
  // federal identity whose Cloud PC silently never builds.
  it('blocks the run rather than planning an unlicensed account into the Cloud PC group', () => {
    const plan = planRun({ ...base, baselineSkus: [] });
    expect(plan.blockers.map((b) => b.code)).toContain('baseline_empty');
  });

  it('still plans zero licences — the blocker is the only thing standing between it and a run', () => {
    const plan = planRun({ ...base, baselineSkus: [] });
    expect(plan.steps.find((s) => s.key === 'assign_licenses')?.detail.skuIds).toEqual([]);
    // ...and the Cloud PC step is still there, which is exactly why the blocker has to be.
    expect(plan.steps.map((s) => s.key)).toContain('assign_cloudpc');
  });

  it('does not fire when a baseline is configured', () => {
    expect(planRun(base).blockers.map((b) => b.code)).not.toContain('baseline_empty');
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 1 — the fingerprint that binds an approved preview to the run
// ---------------------------------------------------------------------------
describe('planFingerprint', () => {
  const plan = planRun(base);

  it('is stable for the same plan', () => {
    expect(planFingerprint(planRun(base))).toBe(planFingerprint(planRun(base)));
  });

  it('survives a JSON round-trip — the plan is stored as jsonb and read back', () => {
    expect(planFingerprint(JSON.parse(JSON.stringify(plan)))).toBe(planFingerprint(plan));
  });

  it('ignores property order, which carries no meaning in an object', () => {
    const reordered = {
      blockers: plan.blockers,
      steps: plan.steps.map((s) => ({ detail: s.detail, label: s.label, key: s.key })) as typeof plan.steps,
      displayName: plan.displayName,
      upn: plan.upn,
    };
    expect(planFingerprint(reordered)).toBe(planFingerprint(plan));
  });

  it('ignores blocker ORDER — a set of reasons, not a sequence', () => {
    const withBlockers = planRun({ ...base, baselineSkus: [], answers: { ...answers, legal_last_name: '' } });
    expect(withBlockers.blockers.length).toBeGreaterThan(1);
    expect(planFingerprint({ ...withBlockers, blockers: [...withBlockers.blockers].reverse() }))
      .toBe(planFingerprint(withBlockers));
  });

  // Each of these is a real edit that could land on tickets.custom_fields, the sensitive store
  // or the tenant between the admin reading a preview and clicking Provision. Every one changes
  // what would be WRITTEN to a live federal directory, so every one must break the binding.
  it('changes when the identity changes', () => {
    const other = planRun({ ...base, answers: { ...answers, legal_last_name: 'Byron' } });
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan));
  });

  it('changes when the group list changes', () => {
    const other = planRun({ ...base, answers: { ...answers, security_groups: 'All Staff, Finance' } });
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan));
  });

  it('changes when the Cloud PC policy changes', () => {
    const other = planRun({
      ...base,
      answers: { ...answers, cloud_pc_policy: '' },
    });
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan));
  });

  it('changes when the licence baseline changes', () => {
    const other = planRun({ ...base, baselineSkus: ['SPE_E3_USGOV_GCCHIGH'] });
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan));
  });

  it('changes when the supervisor who receives the credential changes', () => {
    const other = planRun({ ...base, answers: { ...answers, supervisor: 'sup-2' } });
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan));
  });

  it('changes when resolved group IDS change even though the NAMES did not', () => {
    // What applyGroupResolution writes onto the plan. A group deleted and recreated under the
    // same name is a different directory object, and a different thing to be added to.
    const resolved = (id: string) => ({
      ...plan,
      steps: plan.steps.map((s) =>
        s.key === 'add_groups' ? { ...s, detail: { ...s.detail, groupIds: [id] } } : s),
    });
    expect(planFingerprint(resolved('g-1'))).not.toBe(planFingerprint(resolved('g-2')));
  });

  it('changes when a blocker appears', () => {
    const blocked = planRun({ ...base, existingUser: { id: 'u', userPrincipalName: plan.upn }, existingRoleCount: 1 });
    expect(planFingerprint(blocked)).not.toBe(planFingerprint(plan));
  });

  it('changes when the steps are reordered — licences before the Cloud PC group is material', () => {
    expect(planFingerprint({ ...plan, steps: [...plan.steps].reverse() })).not.toBe(planFingerprint(plan));
  });
});
