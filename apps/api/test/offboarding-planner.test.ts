import { describe, it, expect } from 'vitest';
import {
  inactiveDisplayName, planOffboard, offboardFingerprint, OFFBOARD_STEP_ORDER, type OffboardPlanInput,
} from '../src/modules/offboarding/planner.js';

// The disabled-account name is the only place the retention clock (1yr standard / 7yr
// privileged) is readable straight off the account, so its format is load-bearing rather than
// cosmetic. See docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md.
describe('inactiveDisplayName', () => {
  it('builds the agreed ZZ_Inactive format from the last day', () => {
    expect(inactiveDisplayName('Doe', 'Jane', '2026-09-02')).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });

  it('strips separators out of name parts so the segments stay parseable', () => {
    // Underscore is the segment separator. A surname containing spaces must not produce
    // ZZ_Inactive_Van_Der_Berg_Anne_2026-01-05, which cannot be read back apart.
    expect(inactiveDisplayName('Van Der Berg', 'Anne-Marie', '2026-01-05'))
      .toBe('ZZ_Inactive_VanDerBerg_Anne-Marie_2026-01-05');
  });

  it('refuses a last day that is not an ISO date rather than embedding junk in the name', () => {
    expect(() => inactiveDisplayName('Doe', 'Jane', '09/02/2026')).toThrow(/ISO date/);
  });

  it('refuses a missing last day', () => {
    expect(() => inactiveDisplayName('Doe', 'Jane', '')).toThrow(/ISO date/);
  });
});

const baseInput = (over: Partial<OffboardPlanInput> = {}): OffboardPlanInput => ({
  // The offboarding intake captures departing_user / last_day / legal_hold — NOT name fields.
  // The name for the rename comes from the DIRECTORY account being renamed.
  answers: { last_day: '2026-09-02' },
  departingUpn: 'jane.doe@sbsfederal.com',
  user: {
    id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe',
    accountEnabled: true, givenName: 'Jane', surname: 'Doe',
  },
  directoryRoleCount: 0,
  licenseSkuIds: ['sku-e3'],
  groupIds: ['g-1'],
  mailboxType: 'user',
  ...over,
});

describe('planOffboard', () => {
  it('emits the six steps in the one order that preserves the mailbox', () => {
    expect(planOffboard(baseInput()).steps.map((s) => s.key)).toEqual(OFFBOARD_STEP_ORDER);
  });

  it('marks the mailbox conversion manual — Graph has no conversion endpoint', () => {
    const plan = planOffboard(baseInput());
    expect(plan.steps.filter((s) => s.manual).map((s) => s.key)).toEqual(['convert_shared_mailbox']);
  });

  it('never places license removal before the mailbox conversion', () => {
    // THE constraint this planner exists to protect: an unlicensed mailbox drops into
    // soft-delete and can no longer be converted to shared.
    const keys = planOffboard(baseInput()).steps.map((s) => s.key);
    expect(keys.indexOf('convert_shared_mailbox')).toBeLessThan(keys.indexOf('remove_licenses'));
  });

  it('revokes sessions only after blocking sign-in', () => {
    // Revoking first would leave a window where a live session mints fresh tokens against a
    // still-enabled account.
    const keys = planOffboard(baseInput()).steps.map((s) => s.key);
    expect(keys.indexOf('block_signin')).toBeLessThan(keys.indexOf('revoke_sessions'));
  });

  it('omits the conversion when there is no user mailbox to preserve', () => {
    const keys = planOffboard(baseInput({ mailboxType: 'none' })).steps.map((s) => s.key);
    expect(keys).not.toContain('convert_shared_mailbox');
    expect(keys).toContain('remove_licenses');
  });

  it('omits the conversion when the mailbox is already shared', () => {
    const keys = planOffboard(baseInput({ mailboxType: 'shared' })).steps.map((s) => s.key);
    expect(keys).not.toContain('convert_shared_mailbox');
  });

  it('flags a privileged account so the 7-year retention path applies', () => {
    expect(planOffboard(baseInput({ directoryRoleCount: 2 })).privileged).toBe(true);
    expect(planOffboard(baseInput()).privileged).toBe(false);
  });

  it('blocks on legal hold, because the plan would touch the mailbox and licenses', () => {
    const plan = planOffboard(baseInput({ answers: { ...baseInput().answers, legal_hold: true } }));
    expect(plan.blockers.map((b) => b.code)).toContain('legal_hold');
  });

  it('blocks when the account is not in the tenant', () => {
    expect(planOffboard(baseInput({ user: null })).blockers.map((b) => b.code)).toContain('user_not_found');
  });

  it('blocks a re-run of an account already disabled and renamed', () => {
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'ZZ_Inactive_Doe_Jane_2026-09-02', accountEnabled: false, givenName: 'Jane', surname: 'Doe' },
    }));
    expect(plan.blockers.map((b) => b.code)).toContain('already_offboarded');
  });

  it('does not treat a merely disabled account as already offboarded', () => {
    // Disabled but not renamed is a normal pre-state (HR disabled early); offboarding should
    // still be able to finish the job.
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe', accountEnabled: false, givenName: 'Jane', surname: 'Doe' },
    }));
    expect(plan.blockers.map((b) => b.code)).not.toContain('already_offboarded');
  });

  it('reports a bad last day as a blocker rather than throwing out of the planner', () => {
    const plan = planOffboard(baseInput({ answers: { last_day: 'soon' } }));
    expect(plan.blockers.map((b) => b.code)).toContain('bad_last_day');
  });

  it('carries the computed inactive name so the executor never derives it', () => {
    expect(planOffboard(baseInput()).inactiveName).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });
});

describe('offboardFingerprint', () => {
  it('is stable for the same plan', () => {
    expect(offboardFingerprint(planOffboard(baseInput())))
      .toBe(offboardFingerprint(planOffboard(baseInput())));
  });

  it('changes when the licenses to reclaim change', () => {
    // "reclaim 1 licence" and "reclaim 2 licences" are the same six steps and very different
    // acts, which is why the fingerprint covers step DETAIL and not just the keys.
    expect(offboardFingerprint(planOffboard(baseInput())))
      .not.toBe(offboardFingerprint(planOffboard(baseInput({ licenseSkuIds: ['sku-e3', 'sku-atp'] }))));
  });

  it('changes when the groups to strip change', () => {
    expect(offboardFingerprint(planOffboard(baseInput())))
      .not.toBe(offboardFingerprint(planOffboard(baseInput({ groupIds: ['g-1', 'g-2'] }))));
  });

  it('changes when the account being acted on changes', () => {
    const other = baseInput({
      user: { id: 'u-2', userPrincipalName: 'someone.else@sbsfederal.com', displayName: 'Someone Else', accountEnabled: true },
    });
    expect(offboardFingerprint(planOffboard(baseInput())))
      .not.toBe(offboardFingerprint(planOffboard(other)));
  });
});

// The rename must describe the account actually being renamed, so its name parts come from the
// DIRECTORY, not from form text. The offboarding intake never captured a name at all — building
// the planner against onboarding's legal_first_name/legal_last_name meant every real preview
// derived an empty name and found no user.
describe('planOffboard — name resolution', () => {
  it('builds the inactive name from the directory account given/surname', () => {
    expect(planOffboard(baseInput()).inactiveName).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });

  it('falls back to splitting displayName when given/surname are absent', () => {
    // Plenty of real directory accounts have only a displayName populated.
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'a.b@sbsfederal.com', displayName: 'Ada Lovelace', accountEnabled: true },
    }));
    expect(plan.inactiveName).toBe('ZZ_Inactive_Lovelace_Ada_2026-09-02');
  });

  it('handles a "Last, First" display name', () => {
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'a.b@sbsfederal.com', displayName: 'Townsend, Colleen', accountEnabled: true },
    }));
    expect(plan.inactiveName).toBe('ZZ_Inactive_Townsend_Colleen_2026-09-02');
  });

  it('BLOCKS rather than renaming a live account to a name with empty segments', () => {
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'a.b@sbsfederal.com', displayName: '   ', accountEnabled: true },
    }));
    expect(plan.blockers.map((b) => b.code)).toContain('no_name');
    expect(plan.inactiveName).not.toMatch(/__/);
  });
});

describe('offboardFingerprint — stability against irrelevant variation', () => {
  it('does not report drift merely because Graph returned the same groups in another order', () => {
    // Graph does not promise ordering. Hashing the raw array order would park an unchanged plan
    // at needs_review and make an administrator re-approve a teardown that had not changed.
    const a = planOffboard(baseInput({ groupIds: ['g-1', 'g-2', 'g-3'], licenseSkuIds: ['s-1', 's-2'] }));
    const b = planOffboard(baseInput({ groupIds: ['g-3', 'g-1', 'g-2'], licenseSkuIds: ['s-2', 's-1'] }));
    expect(offboardFingerprint(a)).toBe(offboardFingerprint(b));
  });

  it('still reports drift when the SET of groups actually changes', () => {
    const a = planOffboard(baseInput({ groupIds: ['g-1', 'g-2'] }));
    const b = planOffboard(baseInput({ groupIds: ['g-1', 'g-9'] }));
    expect(offboardFingerprint(a)).not.toBe(offboardFingerprint(b));
  });
});
