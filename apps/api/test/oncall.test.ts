import { describe, it, expect } from 'vitest';
import { currentResponderIndex, repackPositions } from '../src/modules/oncall.js';

const MON = Date.UTC(2026, 0, 5, 9, 0, 0); // anchor Monday 09:00
const day = (n: number) => MON + n * 86_400_000;

describe('On-call rotation math', () => {
  it('returns -1 when there are no participants', () => {
    expect(currentResponderIndex(0, 7, MON, day(3))).toBe(-1);
  });

  it('stays on responder 0 during the first weekly window', () => {
    expect(currentResponderIndex(5, 7, MON, MON)).toBe(0);
    expect(currentResponderIndex(5, 7, MON, day(6))).toBe(0);
  });

  it('advances each rotation period and wraps around the roster', () => {
    expect(currentResponderIndex(5, 7, MON, day(7))).toBe(1); // week 2
    expect(currentResponderIndex(5, 7, MON, day(14))).toBe(2); // week 3
    expect(currentResponderIndex(5, 7, MON, day(35))).toBe(0); // week 6 wraps (5 responders)
  });

  it('handles time before the anchor without going negative', () => {
    const idx = currentResponderIndex(5, 7, MON, day(-7));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(5);
  });
});

describe('repackPositions (re-sequence after a removal)', () => {
  it('assigns contiguous 0-based positions preserving order', () => {
    expect(repackPositions(['a', 'c', 'd'])).toEqual([
      { item: 'a', position: 0 },
      { item: 'c', position: 1 },
      { item: 'd', position: 2 },
    ]);
  });
  it('handles an empty roster', () => {
    expect(repackPositions([])).toEqual([]);
  });
});
