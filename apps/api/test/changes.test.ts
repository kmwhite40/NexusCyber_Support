import { describe, it, expect } from 'vitest';
import {
  requiresCab, canTransition, detectWindowConflicts, allStepsApproved,
  tallyVotes, resolveVote, deriveRisk,
  addBusinessDays, voteDeadlineFor, ecabRoster, snapshotQuorum, voteEligibility, requiresPir,
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
  it('allows cancelling anything not yet under way, and nothing after', () => {
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('cab_review', 'cancelled')).toBe(true);
    expect(canTransition('approved', 'cancelled')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('implementing', 'cancelled')).toBe(false);
    expect(canTransition('closed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(false);
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


describe('requiresPir', () => {
  it('gates only review -> closed', () => {
    expect(requiresPir('review', 'closed')).toBe(true);
    expect(requiresPir('implementing', 'review')).toBe(false);
    expect(requiresPir('scheduled', 'implementing')).toBe(false);
  });
});

describe('addBusinessDays', () => {
  // 2026-07-01 is a Wednesday.
  it('adds plain weekdays within a week', () => {
    expect(addBusinessDays(new Date('2026-07-01T09:00:00Z'), 1).toISOString()).toBe('2026-07-02T09:00:00.000Z');
    expect(addBusinessDays(new Date('2026-07-01T09:00:00Z'), 2).toISOString()).toBe('2026-07-03T09:00:00.000Z');
  });
  it('skips the weekend', () => {
    // Wed + 3 business days -> Mon (Sat/Sun skipped), not Sat.
    expect(addBusinessDays(new Date('2026-07-01T09:00:00Z'), 3).toISOString()).toBe('2026-07-06T09:00:00.000Z');
    // Fri + 1 -> Mon.
    expect(addBusinessDays(new Date('2026-07-03T09:00:00Z'), 1).toISOString()).toBe('2026-07-06T09:00:00.000Z');
    // Starting ON a Saturday, +1 lands on Monday.
    expect(addBusinessDays(new Date('2026-07-04T09:00:00Z'), 1).toISOString()).toBe('2026-07-06T09:00:00.000Z');
  });
  it('preserves the time of day and treats 0/negative as a no-op', () => {
    expect(addBusinessDays(new Date('2026-07-01T23:45:00Z'), 3).toISOString()).toBe('2026-07-06T23:45:00.000Z');
    expect(addBusinessDays(new Date('2026-07-01T09:00:00Z'), 0).toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(addBusinessDays(new Date('2026-07-01T09:00:00Z'), -2).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });
  it('does not mutate its input', () => {
    const from = new Date('2026-07-01T09:00:00Z');
    addBusinessDays(from, 5);
    expect(from.toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });
});

describe('voteDeadlineFor', () => {
  it('gives normal changes +3 business days', () => {
    expect(voteDeadlineFor('normal', new Date('2026-07-01T09:00:00Z')).toISOString()).toBe('2026-07-06T09:00:00.000Z');
  });
  it('gives emergency changes +4 hours (wall clock, weekends included)', () => {
    expect(voteDeadlineFor('emergency', new Date('2026-07-04T22:00:00Z')).toISOString()).toBe('2026-07-05T02:00:00.000Z');
  });
});

describe('ecabRoster', () => {
  const m = (id: string) => ({ user_id: id, weight: 1 });
  it('cuts a larger board down to the chair plus one', () => {
    const r = ecabRoster([m('a'), m('b'), m('c'), m('d')], 'c');
    expect(r.map((x) => x.user_id)).toEqual(['c', 'a']);
  });
  it('falls back to the first member when the chair is not on the board', () => {
    const r = ecabRoster([m('a'), m('b'), m('c')], null);
    expect(r.map((x) => x.user_id)).toEqual(['a', 'b']);
  });
  it('leaves small boards intact', () => {
    expect(ecabRoster([m('a'), m('b')], 'a').map((x) => x.user_id)).toEqual(['a', 'b']);
    expect(ecabRoster([], 'a')).toEqual([]);
  });
});

describe('snapshotQuorum', () => {
  it('clamps quorum to the roster so a vote cannot deadlock', () => {
    expect(snapshotQuorum(5, 2)).toBe(2);
    expect(snapshotQuorum(2, 5)).toBe(2);
  });
  it('never returns less than one', () => {
    expect(snapshotQuorum(0, 3)).toBe(1);
    expect(snapshotQuorum(3, 0)).toBe(1);
  });
});

describe('voteEligibility', () => {
  it('refuses anyone without a change_votes row, whatever the status', () => {
    expect(voteEligibility('cab_review', false)).toBe('not_a_voter');
    expect(voteEligibility('approved', false)).toBe('not_a_voter');
  });
  it('allows a roster member while the change is still in cab_review', () => {
    expect(voteEligibility('cab_review', true)).toBe('ok');
  });
  it('closes the ballot once the change has been resolved', () => {
    expect(voteEligibility('approved', true)).toBe('not_open');
    expect(voteEligibility('rejected', true)).toBe('not_open');
    expect(voteEligibility('draft', true)).toBe('not_open');
    expect(voteEligibility('cancelled', true)).toBe('not_open');
  });
});
