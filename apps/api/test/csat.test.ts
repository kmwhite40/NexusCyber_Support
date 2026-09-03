import { describe, it, expect } from 'vitest';
import { isValidScore } from '../src/modules/csat.js';

describe('isValidScore', () => {
  it('accepts integers 1 through 5', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isValidScore(n)).toBe(true);
  });
  it('rejects out-of-range, non-integer, and non-number values', () => {
    expect(isValidScore(0)).toBe(false);
    expect(isValidScore(6)).toBe(false);
    expect(isValidScore(3.5)).toBe(false);
    expect(isValidScore('5')).toBe(false);
    expect(isValidScore(null)).toBe(false);
  });
});
