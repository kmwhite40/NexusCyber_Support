import { describe, it, expect } from 'vitest';
import { classifyControl, type ControlSignal } from '../src/modules/compliance.js';

const base: ControlSignal = { mapped: 0, satisfied: 0 };

describe('classifyControl', () => {
  it('returns "not_assessed" (not "gap") when no evidence is mapped to a control', () => {
    // An unmapped control has no evidence either way; reporting it as a gap would turn the full
    // 800-53 catalog into ~1,000 unsupported failures in coverage and evidence packages.
    expect(classifyControl({ ...base, mapped: 0, satisfied: 0 })).toBe('not_assessed');
  });

  it('returns "satisfied" when every mapped signal is satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 3 })).toBe('satisfied');
  });

  it('returns "gap" when no mapped signal is satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 0 })).toBe('gap');
  });

  it('returns "partial" when some but not all signals are satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 2 })).toBe('partial');
  });
});
