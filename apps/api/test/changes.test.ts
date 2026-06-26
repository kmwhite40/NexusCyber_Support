import { describe, it, expect } from 'vitest';
import {
  requiresCab, canTransition, detectWindowConflicts, allStepsApproved,
  tallyVotes, resolveVote, deriveRisk,
} from '../src/modules/changes.js';

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

describe('tallyVotes', () => {
  it('counts approve/reject/abstain/pending with weights', () => {
    const t = tallyVotes([
      { vote: 'approve', weight: 1 }, { vote: 'approve', weight: 1 },
      { vote: 'reject', weight: 1 }, { vote: 'abstain', weight: 1 },
      { vote: null, weight: 1 },
    ]);
    expect(t).toEqual({ approve: 2, reject: 1, abstain: 1, pending: 1, cast: 4, roster: 5 });
  });
});

describe('resolveVote', () => {
  const roster = (votes: Array<string | null>) => votes.map((v) => ({ vote: v as any, weight: 1 }));

  it('stays in review until quorum is met', () => {
    expect(resolveVote(roster(['approve', null, null, null, null]), { quorum: 3, threshold: 'majority' })).toBe('cab_review');
  });
  it('approves on majority once quorum met', () => {
    expect(resolveVote(roster(['approve', 'approve', 'reject', null, null]), { quorum: 3, threshold: 'majority' })).toBe('approved');
  });
  it('rejects when threshold can no longer pass', () => {
    expect(resolveVote(roster(['reject', 'reject', 'reject', null, null]), { quorum: 3, threshold: 'majority' })).toBe('rejected');
  });
  it('abstain counts to quorum but not to for/against', () => {
    expect(resolveVote(roster(['approve', 'abstain', 'abstain', null, null]), { quorum: 3, threshold: 'majority' })).toBe('approved');
  });
  it('two_thirds requires >= ceil(2/3) of cast non-abstain', () => {
    expect(resolveVote(roster(['approve', 'approve', 'reject']), { quorum: 3, threshold: 'two_thirds' })).toBe('approved');
    expect(resolveVote(roster(['approve', 'reject', 'reject']), { quorum: 3, threshold: 'two_thirds' })).toBe('rejected');
  });
  it('unanimous requires zero rejects and all non-abstainers approved', () => {
    expect(resolveVote(roster(['approve', 'approve', 'approve']), { quorum: 3, threshold: 'unanimous' })).toBe('approved');
    expect(resolveVote(roster(['approve', 'approve', 'reject']), { quorum: 3, threshold: 'unanimous' })).toBe('rejected');
  });
});

describe('deriveRisk', () => {
  it('maps impact x likelihood to low/medium/high', () => {
    expect(deriveRisk('low', 'low')).toBe('low');
    expect(deriveRisk('high', 'low')).toBe('medium');
    expect(deriveRisk('high', 'high')).toBe('high');
  });
});
