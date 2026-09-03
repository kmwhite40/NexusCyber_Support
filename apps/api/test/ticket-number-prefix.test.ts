import { describe, it, expect } from 'vitest';
import { ticketNumberPrefix } from '../src/modules/tickets.js';

// Regression: an org stored as " Strategic Business Systems (Federal)" (leading
// space, untrimmed at signup) produced ticket numbers like " STR-000001", which
// mailed out as "[ STR-000001] ...". The prefix must come from the letters and
// digits of the name, never from whatever character happens to sit at position 1.
describe('ticketNumberPrefix', () => {
  it('keeps the existing prefix for ordinary names', () => {
    expect(ticketNumberPrefix('Demo Corp')).toBe('DEMO');
  });

  it('ignores leading whitespace', () => {
    expect(ticketNumberPrefix(' Strategic Business Systems (Federal)')).toBe('STRA');
  });

  it('ignores punctuation and spaces inside the name', () => {
    expect(ticketNumberPrefix('SBS Federal')).toBe('SBSF');
    expect(ticketNumberPrefix('A.C.M.E., Inc.')).toBe('ACME');
  });

  it('keeps short names as-is', () => {
    expect(ticketNumberPrefix('AB')).toBe('AB');
  });

  it('falls back when a name has no usable characters', () => {
    expect(ticketNumberPrefix('   ')).toBe('TCKT');
    expect(ticketNumberPrefix(null)).toBe('TCKT');
  });
});
