import { describe, it, expect } from 'vitest';
import { sumMinutes, formatMinutes } from '../src/modules/worklogs.js';

describe('sumMinutes', () => {
  it('sums minutes across entries', () => {
    expect(sumMinutes([{ minutes: 30 }, { minutes: 45 }, { minutes: 15 }])).toBe(90);
  });
  it('handles an empty list', () => {
    expect(sumMinutes([])).toBe(0);
  });
});

describe('formatMinutes', () => {
  it('formats sub-hour durations', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(0)).toBe('0m');
  });
  it('formats whole hours', () => {
    expect(formatMinutes(120)).toBe('2h');
  });
  it('formats hours + minutes', () => {
    expect(formatMinutes(150)).toBe('2h 30m');
  });
});
