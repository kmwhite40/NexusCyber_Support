import { describe, it, expect } from 'vitest';
import { deriveUpn, planRun, planFingerprint, normalizeForMatch, userAttributes } from '../src/modules/provisioning/planner.js';

const tenant = {
  skus: [
    { skuId: 'e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 2 },
    { skuId: 'mde', skuPartNumber: 'MDATP_XPLAT', enabled: 10, consumed: 2 },
    { skuId: 'w365', skuPartNumber: 'CPC_FIXTURE_SKU', enabled: 10, consumed: 8 },
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
  cloudPcSku: 'CPC_FIXTURE_SKU',
  existingUser: null, existingRoleCount: 0,
  // The fixture names a supervisor, so a CLEAN request is one where the caller resolved them.
  // Leaving this out is the unresolved case, and that is a blocker — see the manager tests below.
  manager: { upn: 'sup.one@sbsfederal.com', objectId: 'sup-oid' },
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
    // cloudPcSku is cleared too, so this isolates the BASELINE being empty. With it set, the
    // conditional Cloud PC licence would legitimately resolve and the list would not be empty —
    // a different concern, covered by its own suite.
    const plan = planRun({ ...base, baselineSkus: [], cloudPcSku: '' });
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

  // The tenant really does have TAP disabled. Discovering that by catching an error means
  // discovering it AFTER the account, licences and groups are written — the code's own comment
  // calls that the worst place to stop. Reading the policy up front moves the fact into the
  // preview, where an admin sees it before anything is created.
  it('marks issue_tap as skipped up front when the tenant has TAP disabled', () => {
    const p = planRun({ ...base, tenant: { ...tenant, tapEnabled: false } });
    const step = p.steps.find((s) => s.key === 'issue_tap');
    expect(step).toBeDefined();
    expect(step!.detail.willSkip).toBe(true);
    expect(String(step!.detail.skipReason)).toMatch(/Temporary Access Pass/i);
  });

  it('plans issue_tap normally when the tenant has TAP enabled', () => {
    const p = planRun({ ...base, tenant: { ...tenant, tapEnabled: true } });
    const step = p.steps.find((s) => s.key === 'issue_tap');
    expect(step!.detail.willSkip).toBeFalsy();
  });

  // Unknown state must NOT pre-skip: that would silently stop issuing credentials in a tenant
  // where TAP works fine. The executor's error path stays as the backstop for that case.
  it('does not pre-skip when TAP state is unknown', () => {
    const p = planRun({ ...base, tenant: { ...tenant, tapEnabled: undefined } });
    const step = p.steps.find((s) => s.key === 'issue_tap');
    expect(step!.detail.willSkip).toBeFalsy();
  });

});

// A Cloud PC is NOT part of everyone's onboarding — confirmed with the operator. That makes the
// Windows 365 licence conditional in exactly the way the Cloud PC group membership already was.
// Keeping it in the unconditional baseline charged a scarce, expensive seat to every hire (the
// tenant has 2 free), and would block hire number three with no_seats for a licence they were
// never meant to get.
describe('Cloud PC licence is conditional, like the Cloud PC itself', () => {
  const exhausted = {
    ...tenant,
    skus: tenant.skus.map((s) => (s.skuId === 'w365' ? { ...s, consumed: 10 } : s)),
  };
  const noCloudPc = { ...answers, cloud_pc_policy: '' };

  it('does not consume a Windows 365 seat when no Cloud PC was requested', () => {
    const p = planRun({
      ...base, answers: noCloudPc,
    });
    const lic = p.steps.find((s) => s.key === 'assign_licenses')!;
    expect(lic.detail.skuIds).toEqual(['e3', 'mde']);
    expect(p.steps.some((s) => s.key === 'assign_cloudpc')).toBe(false);
  });

  it('adds the Windows 365 licence when a Cloud PC IS requested', () => {
    const p = planRun({ ...base });
    const lic = p.steps.find((s) => s.key === 'assign_licenses')!;
    expect(lic.detail.skuIds).toEqual(['e3', 'mde', 'w365']);
    expect(p.steps.some((s) => s.key === 'assign_cloudpc')).toBe(true);
  });

  // The ordering hazard, from the other side: a Cloud PC requested with no licence to give it
  // must FAIL THE DRY RUN, never proceed to put an unlicensed account in the policy group.
  it('blocks when a Cloud PC is requested but no Windows 365 SKU is configured', () => {
    const p = planRun({ ...base, cloudPcSku: '' });
    expect(p.blockers.map((b) => b.code)).toContain('cloudpc_sku_unconfigured');
  });

  it('blocks when the Windows 365 pool is exhausted', () => {
    const p = planRun({ ...base, tenant: exhausted });
    expect(p.blockers.map((b) => b.code)).toContain('no_seats');
  });

  // Seats are only checked for what will actually be assigned. An exhausted W365 pool must not
  // block a hire who is not getting a Cloud PC at all.
  it('ignores an exhausted Windows 365 pool when no Cloud PC was requested', () => {
    const p = planRun({ ...base, answers: noCloudPc, tenant: exhausted });
    expect(p.blockers).toEqual([]);
  });
});

// Noticed in the Entra portal after the first successful run: the created account had a display
// name but EMPTY First name and Last name. Not cosmetic — offboarding's nameParts() prefers
// givenName/surname and otherwise GUESSES by splitting displayName, returning null (a blocker)
// when it cannot. So every account this engine created forced that guess downstream, while the
// planner held the exact names the whole time.
describe('create_user carries the real given name and surname', () => {
  it('passes givenName and surname, not just a display name', () => {
    const p = planRun({ ...base });
    const step = p.steps.find((s) => s.key === 'create_user')!;
    expect(step.detail.givenName).toBe('Ada');
    expect(step.detail.surname).toBe('Lovelace');
    expect(step.detail.displayName).toBe('Ada Lovelace');
  });

  // givenName tracks whatever the display name uses, so the GAL and the directory field agree.
  it('uses the preferred first name when there is one, matching displayName', () => {
    const p = planRun({ ...base, answers: { ...answers, preferred_first_name: 'Addy' } });
    const step = p.steps.find((s) => s.key === 'create_user')!;
    expect(step.detail.givenName).toBe('Addy');
    expect(step.detail.displayName).toBe('Addy Lovelace');
    expect(step.detail.surname).toBe('Lovelace');
  });
});

// SBS convention: contractors carry a .ctr suffix on the UPN, so the account itself says what the
// person is. Without it, a contractor is indistinguishable from staff in the directory, in the
// GAL, and in every audit export — the distinction the suffix exists to make is exactly the one
// an auditor asks about.
describe('contractor UPNs', () => {
  const contractor = (over: Record<string, unknown> = {}) => ({ ...answers, ...over });

  it('appends .ctr for an employment type of Contractor', () => {
    expect(deriveUpn(contractor({ employment_type: 'Contractor' }), 'sbsfederal.com'))
      .toBe('ada.lovelace.ctr@sbsfederal.com');
  });

  // Two fields can say "not an employee" — the form asks both, and either answer counts.
  it('appends .ctr for a hire type of Consultant', () => {
    expect(deriveUpn(contractor({ hire_type: 'Consultant' }), 'sbsfederal.com'))
      .toBe('ada.lovelace.ctr@sbsfederal.com');
  });

  it('leaves permanent staff alone', () => {
    expect(deriveUpn(contractor({ employment_type: 'Full-time', hire_type: 'Direct Hire' }), 'sbsfederal.com'))
      .toBe('ada.lovelace@sbsfederal.com');
  });

  it('does not double the suffix', () => {
    expect(deriveUpn(contractor({ employment_type: 'Contractor', hire_type: 'Consultant' }), 'sbsfederal.com'))
      .toBe('ada.lovelace.ctr@sbsfederal.com');
  });

  it('still uses the preferred first name', () => {
    expect(deriveUpn(contractor({ preferred_first_name: 'Addy', employment_type: 'Contractor' }), 'sbsfederal.com'))
      .toBe('addy.lovelace.ctr@sbsfederal.com');
  });
});

// "Copy access from (mirror user)" was collected by the form and read by nothing. Wiring it up
// means the approver must see WHAT is being copied — the request says "copy access from Mike",
// and Mike holds 23 groups including one that can carry a directory role.
describe('mirrored access', () => {
  const withMirror = (mirror: Parameters<typeof planRun>[0]['mirror']) =>
    planRun({ ...base, mirror });

  it('adds the mirror user\'s ordinary groups to the plan', () => {
    const p = withMirror({ upn: 'mike.rohan@sbsfederal.com', assignable: ['DL-FED', 'Ember Hawk'], roleAssignable: [], dynamic: [] });
    const step = p.steps.find((s) => s.key === 'add_groups')!;
    expect(step.detail.groups).toEqual(expect.arrayContaining(['DL-FED', 'Ember Hawk']));
  });

  // Held back, not copied. The blocker forces the approver to look at the name.
  it('refuses to copy a role-assignable group without it being seen', () => {
    const p = withMirror({ upn: 'mike.rohan@sbsfederal.com', assignable: ['DL-FED'], roleAssignable: ['SBS_Dev_Users'], dynamic: [] });
    expect(p.blockers.map((b) => b.code)).toContain('mirror_privileged_group');
    expect(p.blockers.find((b) => b.code === 'mirror_privileged_group')!.message).toContain('SBS_Dev_Users');
    const step = p.steps.find((s) => s.key === 'add_groups')!;
    expect(step.detail.groups).not.toContain('SBS_Dev_Users');
  });

  // Not a blocker: nothing is wrong, the membership simply cannot be copied and saying so beats
  // a silent omission the requester discovers later.
  it('reports dynamic groups as uncopyable rather than failing', () => {
    const p = withMirror({ upn: 'x@y.gov', assignable: ['DL-FED'], roleAssignable: [], dynamic: ['Auto-All'] });
    expect(p.blockers.map((b) => b.code)).not.toContain('mirror_privileged_group');
    const step = p.steps.find((s) => s.key === 'add_groups')!;
    expect(step.detail.mirrorSkippedDynamic).toEqual(['Auto-All']);
  });

  it('leaves the plan untouched when no mirror user was named', () => {
    const p = planRun({ ...base });
    const step = p.steps.find((s) => s.key === 'add_groups')!;
    expect(step.detail.groups).toEqual(['All Staff']);
  });

  it('does not duplicate a group the requester already asked for', () => {
    const p = withMirror({ upn: 'x@y.gov', assignable: ['All Staff', 'DL-FED'], roleAssignable: [], dynamic: [] });
    const groups = (p.steps.find((s) => s.key === 'add_groups')!.detail.groups as string[]);
    expect(groups.filter((x) => x === 'All Staff')).toHaveLength(1);
  });
});

// Reported from the tenant after a real run: "most of the fields were not automatically populated
// under a user profile like work location supervisor and groups". The account was being created
// with seven properties — accountEnabled, displayName, UPN, mailNickname, usageLocation,
// givenName, surname — and every other answer the SBS intake collects was validated, stored on
// the ticket, and then dropped. The directory record showed a name and nothing else.
describe('userAttributes', () => {
  const full = {
    job_title: 'Systems Engineer',
    department: 'Engineering',
    duty_location: 'Chantilly, VA',
    employee_id: 'E-4417',
    cell_phone: '703-555-0142',
    start_date: '2026-10-05',
    employment_type: 'full-time',
  };

  it('maps the intake answers onto the Graph user properties', () => {
    expect(userAttributes(full)).toEqual({
      jobTitle: 'Systems Engineer',
      department: 'Engineering',
      officeLocation: 'Chantilly, VA',
      employeeId: 'E-4417',
      mobilePhone: '703-555-0142',
      employeeHireDate: '2026-10-05T00:00:00Z',
      employeeType: 'Employee',
    });
  });

  // An answer left blank must be ABSENT, not an empty string. The same object is used to fill
  // gaps on an adopted account, where writing '' would erase a real person's existing value.
  it('omits blank answers entirely rather than sending empty strings', () => {
    const out = userAttributes({ job_title: 'Analyst', department: '   ', duty_location: '' });
    expect(out).toEqual({ jobTitle: 'Analyst', employeeType: 'Employee' });
    expect('department' in out).toBe(false);
    expect('officeLocation' in out).toBe(false);
  });

  // The .ctr UPN suffix already separates contractors in the GAL; employeeType makes the same
  // distinction available to filters, dynamic groups and audit exports that never see the UPN.
  it('marks contractors as such', () => {
    expect(userAttributes({ hire_type: 'Contractor' }).employeeType).toBe('Contractor');
    expect(userAttributes({ employment_type: 'subcontractor' }).employeeType).toBe('Contractor');
  });

  // Graph wants a DateTimeOffset; the form field is a plain date. A start date that is not a
  // plain date is dropped rather than guessed at — a wrong hire date is worse than none.
  it('sends the hire date as an instant, and drops anything that is not a date', () => {
    expect(userAttributes({ start_date: '2026-01-02' }).employeeHireDate).toBe('2026-01-02T00:00:00Z');
    expect(userAttributes({ start_date: 'next monday' }).employeeHireDate).toBeUndefined();
    expect(userAttributes({ start_date: '' }).employeeHireDate).toBeUndefined();
  });

  // The home address is captured for HR and marked sensitive. The directory is readable by the
  // whole tenant through the GAL, so it stays out of it — as does "work location", which answers
  // Work from Home / On Site. That is a working arrangement, not a place, and officeLocation is
  // a place. Duty location is the field that holds one.
  it('keeps the home address and the work-arrangement answer out of the directory', () => {
    const out = userAttributes({
      ...full,
      home_address_street: '12 Elm St',
      home_address_csz: 'Reston, VA 20190',
      personal_email: 'someone@example.com',
      work_location: 'Work from Home - Permanent',
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('Elm St');
    expect(blob).not.toContain('Reston');
    expect(blob).not.toContain('example.com');
    expect(blob).not.toContain('Work from Home');
    expect(out.officeLocation).toBe('Chantilly, VA');
  });
});

describe('planRun carries the profile onto create_user', () => {
  it('puts the mapped attributes on the step so the executor can send them', () => {
    const p = planRun({ ...base, answers: { ...answers, job_title: 'Analyst', duty_location: 'Chantilly, VA' } });
    const step = p.steps.find((s) => s.key === 'create_user');
    expect(step?.detail.attributes).toMatchObject({ jobTitle: 'Analyst', officeLocation: 'Chantilly, VA' });
  });
});

// The Supervisor field carries maps_to='manager', but maps_to links a form field to a TICKET
// attribute. Nothing ever wrote the Entra manager relationship, so every provisioned account had
// an empty manager — and with it, no manager chain for dynamic groups, approvals or offboarding.
describe('planRun and the manager relationship', () => {
  const withSup = { ...answers, supervisor: 'nexus-user-1' };

  it('adds a set_manager step once the supervisor resolves to a directory object', () => {
    const p = planRun({ ...base, answers: withSup, manager: { upn: 'pat.lee@sbsfederal.com', objectId: 'mgr-oid' } });
    const step = p.steps.find((s) => s.key === 'set_manager');
    expect(step?.detail).toMatchObject({ managerObjectId: 'mgr-oid', managerUpn: 'pat.lee@sbsfederal.com' });
  });

  // Before the account exists, not after. The whole point of the preview is that an approver sees
  // what will and will not happen while nothing has been written yet.
  it('blocks in the PREVIEW when a supervisor is named but cannot be resolved', () => {
    const p = planRun({ ...base, answers: withSup, manager: undefined });
    expect(p.blockers.map((b) => b.code)).toContain('manager_unresolved');
    expect(p.steps.map((s) => s.key)).not.toContain('set_manager');
  });

  it('does not block when no supervisor was asked for', () => {
    const p = planRun({ ...base, answers: { ...answers, supervisor: '' }, manager: undefined });
    expect(p.blockers.map((b) => b.code)).not.toContain('manager_unresolved');
    expect(p.steps.map((s) => s.key)).not.toContain('set_manager');
  });

  // The manager is set on the account this run creates, so it can only run after create_user.
  it('orders set_manager after the account exists', () => {
    const keys = planRun({ ...base, answers: withSup, manager: { upn: 'p@x', objectId: 'm' } }).steps.map((s) => s.key);
    expect(keys.indexOf('create_user')).toBeLessThan(keys.indexOf('set_manager'));
  });
});

// security_groups became a multi-select backed by the tenant's real group list, so the answer is
// now an ARRAY of names. The free-text form stays readable: every request raised before the
// change is stored as a comma- or newline-separated string, and those tickets still have to plan.
describe('security_groups as a list', () => {
  const groupsOf = (p: ReturnType<typeof planRun>) =>
    (p.steps.find((s) => s.key === 'add_groups')?.detail.groups as string[] | undefined) ?? [];

  it('takes an array of chosen names', () => {
    expect(groupsOf(planRun({ ...base, answers: { ...answers, security_groups: ['All Staff', 'Engineering'] } })))
      .toEqual(['All Staff', 'Engineering']);
  });

  it('still reads a legacy free-text answer', () => {
    expect(groupsOf(planRun({ ...base, answers: { ...answers, security_groups: 'All Staff, Engineering' } })))
      .toEqual(['All Staff', 'Engineering']);
    expect(groupsOf(planRun({ ...base, answers: { ...answers, security_groups: 'All Staff\nEngineering' } })))
      .toEqual(['All Staff', 'Engineering']);
  });

  it('ignores blanks and non-strings in either shape', () => {
    expect(groupsOf(planRun({ ...base, answers: { ...answers, security_groups: ['All Staff', '', '  ', 7 as any] } })))
      .toEqual(['All Staff']);
    expect(groupsOf(planRun({ ...base, answers: { ...answers, security_groups: [] } }))).toEqual([]);
  });
});

// Reported from the tenant: new starters are told the password is invalid on first use.
//
// The account is created with a RANDOM password that is generated, sent to Graph, and discarded
// unread — nobody ever learns it, which is the point, because the Temporary Access Pass is meant
// to be the first-sign-in credential. It was also created with forceChangePasswordNextSignIn.
// Those two cannot both hold: Entra asks for the CURRENT password before it will accept a new
// one, and the current password is the value nobody has. The new starter signs in with the pass,
// is asked to change a password they were never given, types the pass into the field, and is
// told it is invalid.
//
// So the force-change flag follows the credential: off when a pass is being issued (the pass IS
// the first-sign-in method), on when the tenant has TAP disabled and an admin therefore sets a
// credential out of band — which is the one case where a forced change at next sign-in is right.
describe('forceChangePassword tracks how the first sign-in actually happens', () => {
  const forceOf = (p: ReturnType<typeof planRun>) =>
    p.steps.find((s) => s.key === 'create_user')?.detail.forceChangePassword;

  it('is off when a Temporary Access Pass will be issued', () => {
    expect(forceOf(planRun({ ...base, tenant: { ...tenant, tapEnabled: true } }))).toBe(false);
    // Unknown is not "disabled": the run still attempts the pass, so the pass is still the path in.
    expect(forceOf(planRun({ ...base, tenant: { ...tenant, tapEnabled: undefined } }))).toBe(false);
  });

  it('is on when the tenant has no Temporary Access Pass and an admin sets the credential', () => {
    expect(forceOf(planRun({ ...base, tenant: { ...tenant, tapEnabled: false } }))).toBe(true);
  });
});

// Asked for after "the password is invalid on first use": an alternative that works the way the
// Entra admin centre does — set a temporary password, hand it over, make them change it. A
// Temporary Access Pass is the stronger credential and stays the default, but a password is what
// the team already knows, and it is the honest answer for a tenant with no TAP policy at all,
// where today the run creates a live account that nobody can sign into and nothing sets.
describe('initialCredential', () => {
  const keys = (over: Record<string, unknown>) =>
    planRun({ ...base, ...over }).steps.map((s) => s.key);

  it('issues a Temporary Access Pass by default', () => {
    expect(keys({})).toContain('issue_tap');
    expect(keys({})).not.toContain('set_password');
  });

  it('sets a temporary password instead when that is configured', () => {
    const k = keys({ initialCredential: 'password' as const });
    expect(k).toContain('set_password');
    expect(k).not.toContain('issue_tap');
  });

  // The two are alternatives, never both: each hands the new starter a live credential, and
  // minting two means one of them is loose with nobody expecting it.
  it('never plans both', () => {
    for (const c of ['tap', 'password'] as const) {
      const k = keys({ initialCredential: c });
      expect(k.filter((x) => x === 'issue_tap' || x === 'set_password')).toHaveLength(1);
    }
  });

  // A password the user must change is the whole point of this mode — and unlike the TAP case it
  // IS satisfiable, because the password is delivered rather than discarded.
  it('demands a change at next sign-in, which is what makes it temporary', () => {
    const p = planRun({ ...base, initialCredential: 'password' });
    expect(p.steps.find((s) => s.key === 'create_user')?.detail.forceChangePassword).toBe(true);
  });

  it('carries the supervisor so the credential has somewhere to go', () => {
    const p = planRun({ ...base, initialCredential: 'password' });
    expect(p.steps.find((s) => s.key === 'set_password')?.detail.supervisor).toBe('sup-1');
  });
});
