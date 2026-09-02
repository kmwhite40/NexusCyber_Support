import { describe, it, expect } from 'vitest';
import { inactiveDisplayName } from '../src/modules/offboarding/planner.js';

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
