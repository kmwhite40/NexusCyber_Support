import { describe, it, expect } from 'vitest';
import { validateAgainstForm } from '../src/modules/forms.js';
import type { FormField } from '../src/modules/form-fields.js';

const field = (over: Partial<FormField>): FormField => ({
  key: 'f', label: 'Field', data_type: 'select', required: false, options: [],
  maps_to: null, visible_when: null, sensitive: false, options_source: null, ...over,
} as FormField);

// Reported from real use: submitting an onboarding request failed with
//   "Cloud PC provisioning policy must be one of:"
// — the allowed list empty, while the dropdown plainly showed "SBSFederal Cloud PC" selected.
//
// The field's values come LIVE from Graph via options_source; its stored `options` array is empty
// by design. Validating a live-sourced select against the static list could therefore never pass,
// so the entire Cloud PC path of onboarding was unreachable — the exact path this tenant uses.
describe('select fields whose options come from a live source', () => {
  it('accepts a value that is not in the empty static list', () => {
    const f = field({ key: 'cloud_pc_policy', label: 'Cloud PC provisioning policy', options_source: 'cloudpc_policies' });
    const r = validateAgainstForm([f], { cloud_pc_policy: 'SBSFederal Cloud PC' });
    expect(r.ok).toBe(true);
  });

  // Whether the name matches a REAL policy is settled against the tenant by the provisioning
  // planner, which raises a policy_missing blocker. Re-checking it here would mean a Graph call
  // during form validation, and getting it wrong would block a legitimate request.
  it('leaves the real check to the planner rather than guessing', () => {
    const f = field({ key: 'cloud_pc_policy', label: 'Cloud PC', options_source: 'cloudpc_policies' });
    expect(validateAgainstForm([f], { cloud_pc_policy: 'Anything At All' }).ok).toBe(true);
  });

  it('still enforces the list for an ordinary static select', () => {
    const f = field({ key: 'hardware', label: 'Hardware needed', options: ['Laptop', 'Desktop'] });
    expect(validateAgainstForm([f], { hardware: 'Laptop' }).ok).toBe(true);
    const bad = validateAgainstForm([f], { hardware: 'Hovercraft' });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toContain('Laptop, Desktop');
  });

  // A required live-sourced select must still be required — the fix is about the VALUE check,
  // not about letting the field go empty.
  it('still requires a required live-sourced select', () => {
    const f = field({ key: 'cloud_pc_policy', label: 'Cloud PC', required: true, options_source: 'cloudpc_policies' });
    expect(validateAgainstForm([f], {}).ok).toBe(false);
  });
});
