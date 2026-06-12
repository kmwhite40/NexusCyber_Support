import { describe, it, expect } from 'vitest';
import { canAlertTransition } from '../src/modules/alerts.js';

describe('canAlertTransition', () => {
  it('triggered can be acknowledged or resolved', () => {
    expect(canAlertTransition('triggered', 'acknowledged')).toBe(true);
    expect(canAlertTransition('triggered', 'resolved')).toBe(true);
  });
  it('acknowledged can be resolved', () => { expect(canAlertTransition('acknowledged', 'resolved')).toBe(true); });
  it('resolved is terminal', () => {
    expect(canAlertTransition('resolved', 'acknowledged')).toBe(false);
    expect(canAlertTransition('resolved', 'triggered')).toBe(false);
  });
  it('no-op and backward transitions are rejected', () => {
    expect(canAlertTransition('acknowledged', 'triggered')).toBe(false);
    expect(canAlertTransition('triggered', 'triggered')).toBe(false);
  });
});
