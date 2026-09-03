import { describe, it, expect } from 'vitest';
import { validateSteps, stepForElapsed } from '../src/modules/escalation-policies.js';

describe('validateSteps', () => {
  it('accepts ordered schedule/user steps and normalizes order', () => {
    const s = validateSteps([{ targetType: 'schedule', targetId: 'a', delayMinutes: 0 }, { targetType: 'user', targetId: 'b', delayMinutes: 15 }]);
    expect(s.map((x) => x.order)).toEqual([1, 2]);
  });
  it('rejects empty steps, bad targetType, negative delay', () => {
    expect(() => validateSteps([])).toThrow();
    expect(() => validateSteps([{ targetType: 'group', targetId: 'x', delayMinutes: 0 } as any])).toThrow();
    expect(() => validateSteps([{ targetType: 'user', targetId: 'x', delayMinutes: -1 }])).toThrow();
  });
});

describe('stepForElapsed', () => {
  const steps = [
    { order: 1, targetType: 'schedule', targetId: 'a', delayMinutes: 0 },
    { order: 2, targetType: 'user', targetId: 'b', delayMinutes: 10 },
    { order: 3, targetType: 'user', targetId: 'c', delayMinutes: 30 },
  ] as any;
  it('returns the active step for elapsed minutes (cumulative >= delay)', () => {
    expect(stepForElapsed(steps, 0).order).toBe(1);
    expect(stepForElapsed(steps, 9).order).toBe(1);
    expect(stepForElapsed(steps, 10).order).toBe(2);
    expect(stepForElapsed(steps, 45).order).toBe(3);
  });
});
