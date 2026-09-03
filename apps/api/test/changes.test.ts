import { describe, it, expect } from 'vitest';
import {
  requiresCab, canTransition, detectWindowConflicts, allStepsApproved,
  tallyVotes, resolveVote, isVoteOverdue, deriveRisk,
  addBusinessDays, voteDeadlineFor, ecabRoster, snapshotQuorum, voteEligibility, requiresPir,
  recuseRaiser, mayCancel, preapprovalGranted, mayComposeRoster,
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
    expect(t).toEqual({ approve: 2, reject: 1, abstain: 1, pending: 1, cast: 4, roster: 5, standing_cast: 4, standing_roster: 5 });
  });

  it('separates standing-board weight from ad-hoc reviewers', () => {
    const t = tallyVotes([
      { vote: 'approve', weight: 2 },
      { vote: 'approve', weight: 1, ad_hoc: true },
      { vote: null, weight: 1 },
    ]);
    expect(t).toMatchObject({ cast: 3, roster: 4, standing_cast: 2, standing_roster: 3 });
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

  // Quorum is the STANDING board's property. Ad-hoc reviewers are attached to one change by
  // whoever submits it, so if their ballots counted toward quorum the submitter could make
  // the board quorate with people they chose — the packing half of "the raiser picks their
  // own approvers". They are still counted in the THRESHOLD, so this stops ad-hoc voters
  // resolving a vote the standing board has not turned out for; it does not stop them
  // outweighing one that has. The authority to attach them is the control there.
  it('does not let ad-hoc ballots satisfy quorum', () => {
    const rows = [
      { vote: 'approve' as const, weight: 1, ad_hoc: true },
      { vote: 'approve' as const, weight: 1, ad_hoc: true },
      { vote: null, weight: 1 },
    ];
    expect(resolveVote(rows, { quorum: 1, threshold: 'majority' })).toBe('cab_review');
    // …and the standing member's own ballot is what makes it quorate.
    expect(
      resolveVote([...rows.slice(0, 2), { vote: 'approve' as const, weight: 1 }], { quorum: 1, threshold: 'majority' }),
    ).toBe('approved');
  });
});

describe('isVoteOverdue (the deadline sweeper\'s pure predicate)', () => {
  const NOW = new Date('2026-06-20T12:00:00.000Z');
  const base = { status: 'cab_review', cab_quorum: 2 };
  const noBallots: Array<{ vote: null; weight: number }> = [];
  const quorateBallots = [
    { vote: 'approve' as const, weight: 1 },
    { vote: 'approve' as const, weight: 1 },
  ];

  it('is false before the deadline, even with quorum unmet', () => {
    const change = { ...base, vote_deadline: '2026-06-20T12:00:00.001Z' }; // 1ms in the future
    expect(isVoteOverdue(change, noBallots, NOW)).toBe(false);
  });

  it('is true exactly at the deadline boundary (>=, not >) with quorum unmet', () => {
    const change = { ...base, vote_deadline: '2026-06-20T12:00:00.000Z' };
    expect(isVoteOverdue(change, noBallots, NOW)).toBe(true);
  });

  it('is true well past the deadline with quorum unmet', () => {
    const change = { ...base, vote_deadline: '2026-06-18T00:00:00.000Z' };
    expect(isVoteOverdue(change, noBallots, NOW)).toBe(true);
  });

  it('is false once quorum is met, even past deadline — the board showed up', () => {
    const change = { ...base, vote_deadline: '2026-06-18T00:00:00.000Z' };
    expect(isVoteOverdue(change, quorateBallots, NOW)).toBe(false);
  });

  it('is false for a change that is not (or no longer) cab_review', () => {
    const change = { ...base, status: 'approved', vote_deadline: '2026-06-18T00:00:00.000Z' };
    expect(isVoteOverdue(change, noBallots, NOW)).toBe(false);
  });

  it('is false with no vote_deadline set', () => {
    const change = { ...base, vote_deadline: null };
    expect(isVoteOverdue(change, noBallots, NOW)).toBe(false);
  });

  it('does not let ad-hoc reviewer ballots satisfy quorum (mirrors resolveVote)', () => {
    const change = { ...base, vote_deadline: '2026-06-18T00:00:00.000Z' };
    const adHocOnly = [
      { vote: 'approve' as const, weight: 1, ad_hoc: true },
      { vote: 'approve' as const, weight: 1, ad_hoc: true },
    ];
    expect(isVoteOverdue(change, adHocOnly, NOW)).toBe(true); // still overdue: standing quorum unmet
  });

  it('defaults `now` to the current time when omitted', () => {
    const soon = new Date(Date.now() + 60_000).toISOString(); // 1 minute from now
    const change = { ...base, vote_deadline: soon };
    expect(isVoteOverdue(change, noBallots)).toBe(false);
    const past = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    expect(isVoteOverdue({ ...change, vote_deadline: past }, noBallots)).toBe(true);
  });
});

describe('preapprovalGranted (a standard change is not self-declarable)', () => {
  it('refuses a standard change with no template behind it', () => {
    expect(preapprovalGranted('standard', null)).toBe(false);
    expect(preapprovalGranted('standard', undefined)).toBe(false);
  });
  it('refuses a standard change whose template is not itself pre-approved', () => {
    expect(preapprovalGranted('standard', { change_type: 'normal' })).toBe(false);
    expect(preapprovalGranted('standard', { change_type: null })).toBe(false);
  });
  it('grants pre-approval from a standard template', () => {
    expect(preapprovalGranted('standard', { change_type: 'standard' })).toBe(true);
  });
  it('does not constrain change types that still go to the CAB', () => {
    expect(preapprovalGranted('normal', null)).toBe(true);
    expect(preapprovalGranted('emergency', null)).toBe(true);
  });
});

describe('mayComposeRoster (the raiser does not pick their own approvers)', () => {
  const base = { actorId: 'u1', raiserId: 'u2', hasCabManage: false, isChair: false };
  it('refuses the raiser, whatever else they hold', () => {
    expect(mayComposeRoster({ ...base, actorId: 'u2', hasCabManage: true, isChair: true })).toBe(false);
  });
  it('refuses anyone with no standing authority over the roster', () => {
    expect(mayComposeRoster(base)).toBe(false);
  });
  it('allows the chair and a CAB administrator who did not raise it', () => {
    expect(mayComposeRoster({ ...base, isChair: true })).toBe(true);
    expect(mayComposeRoster({ ...base, hasCabManage: true })).toBe(true);
  });
  it('treats an unattributed change as composable by an authorised actor', () => {
    expect(mayComposeRoster({ ...base, raiserId: null, hasCabManage: true })).toBe(true);
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
  it('passes the board quorum through untouched when the roster can meet it', () => {
    expect(snapshotQuorum(2, 5)).toEqual({ quorum: 2, requested: 2, clamped: false });
    expect(snapshotQuorum(3, 3)).toEqual({ quorum: 3, requested: 3, clamped: false });
  });
  it('clamps quorum to the roster so a vote cannot deadlock', () => {
    expect(snapshotQuorum(5, 2)).toEqual({ quorum: 2, requested: 5, clamped: true });
  });
  it('never returns less than one', () => {
    expect(snapshotQuorum(0, 3)).toEqual({ quorum: 1, requested: 1, clamped: false });
    expect(snapshotQuorum(3, 0)).toEqual({ quorum: 1, requested: 3, clamped: true });
  });
  it('reports the board-configured quorum so the weakening is never silent', () => {
    // A board configured at 5 whose membership fell to 3 must not quietly vote at 3.
    const snap = snapshotQuorum(5, 3);
    expect(snap.requested).toBe(5);
    expect(snap.clamped).toBe(true);
  });
});

describe('recuseRaiser (segregation of duties)', () => {
  const v = (id: string) => ({ user_id: id, weight: 1 });
  it('drops the change raiser from their own roster', () => {
    expect(recuseRaiser([v('a'), v('b'), v('c')], 'b').map((x) => x.user_id)).toEqual(['a', 'c']);
  });
  it('drops the raiser even when they added themselves as an ad-hoc reviewer', () => {
    expect(recuseRaiser([v('a')], 'a')).toEqual([]);
  });
  it('leaves the roster alone when the raiser is not on it', () => {
    expect(recuseRaiser([v('a'), v('b')], 'z').map((x) => x.user_id)).toEqual(['a', 'b']);
    expect(recuseRaiser([v('a')], null).map((x) => x.user_id)).toEqual(['a']);
  });
});

describe('mayCancel', () => {
  it('lets the raiser withdraw their own change', () => {
    expect(mayCancel({ actorId: 'u1', createdBy: 'u1', hasImplement: false })).toBe(true);
  });
  it('lets a change manager cancel anyone\'s change', () => {
    expect(mayCancel({ actorId: 'u2', createdBy: 'u1', hasImplement: true })).toBe(true);
  });
  it("refuses another author cancelling someone else's change", () => {
    expect(mayCancel({ actorId: 'u2', createdBy: 'u1', hasImplement: false })).toBe(false);
    expect(mayCancel({ actorId: 'u2', createdBy: null, hasImplement: false })).toBe(false);
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
  it('refuses the raiser even if a roster row somehow exists (SoD backstop)', () => {
    expect(voteEligibility('cab_review', true, true)).toBe('self_raised');
  });
  it('closes the ballot once the change has been resolved', () => {
    expect(voteEligibility('approved', true)).toBe('not_open');
    expect(voteEligibility('rejected', true)).toBe('not_open');
    expect(voteEligibility('draft', true)).toBe('not_open');
    expect(voteEligibility('cancelled', true)).toBe('not_open');
  });
});
