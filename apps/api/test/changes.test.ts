import { describe, it, expect } from 'vitest';
import { requiresCab, canTransition, detectWindowConflicts, allStepsApproved } from '../src/modules/changes.js';

describe('requiresCab', () => {
  it('standard changes are pre-approved (no CAB)', () => {
    expect(requiresCab('standard')).toBe(false);
  });
  it('normal and emergency changes require CAB', () => {
    expect(requiresCab('normal')).toBe(true);
    expect(requiresCab('emergency')).toBe(true);
  });
});

describe('canTransition (change lifecycle)', () => {
  it('allows the happy path approved -> scheduled -> implementing -> review -> closed', () => {
    expect(canTransition('approved', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'implementing')).toBe(true);
    expect(canTransition('implementing', 'review')).toBe(true);
    expect(canTransition('review', 'closed')).toBe(true);
  });
  it('rejects skipping states', () => {
    expect(canTransition('approved', 'implementing')).toBe(false);
    expect(canTransition('draft', 'scheduled')).toBe(false);
  });
});

describe('detectWindowConflicts', () => {
  const existing = [
    { id: 'a', window_start: '2026-07-01T10:00:00Z', window_end: '2026-07-01T12:00:00Z' },
    { id: 'b', window_start: '2026-07-02T10:00:00Z', window_end: '2026-07-02T12:00:00Z' },
  ];
  it('finds an overlapping window', () => {
    const c = detectWindowConflicts({ start: new Date('2026-07-01T11:00:00Z'), end: new Date('2026-07-01T13:00:00Z') }, existing);
    expect(c.map((x) => x.id)).toEqual(['a']);
  });
  it('ignores non-overlapping windows', () => {
    const c = detectWindowConflicts({ start: new Date('2026-07-03T10:00:00Z'), end: new Date('2026-07-03T12:00:00Z') }, existing);
    expect(c).toEqual([]);
  });
  it('ignores the change being rescheduled (ignoreId)', () => {
    const c = detectWindowConflicts({ start: new Date('2026-07-01T11:00:00Z'), end: new Date('2026-07-01T13:00:00Z') }, existing, 'a');
    expect(c).toEqual([]);
  });
});

describe('allStepsApproved', () => {
  it('is true only when every step is approved', () => {
    expect(allStepsApproved([{ decision: 'approved' }, { decision: 'approved' }])).toBe(true);
    expect(allStepsApproved([{ decision: 'approved' }, { decision: null }])).toBe(false);
    expect(allStepsApproved([])).toBe(false);
  });
});
