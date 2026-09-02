// VotePanel — the surface a CAB member actually votes on.
//
// What these tests are guarding:
//  * the tally/quorum numbers rendered are the ones the API snapshotted, not a
//    client-side recount that could drift from the resolver;
//  * the Approve/Reject/Abstain controls appear for a member holding a PENDING ballot
//    and for nobody else — not for a non-member, not for the recused raiser, not for a
//    change that has left cab_review;
//  * a clamped (weakened) quorum is stated, not buried — this is the whole reason
//    changes.cab_quorum_requested is persisted;
//  * the recused raiser reads as recused rather than as a missing voter;
//  * casting a vote posts the real { vote, reason } body to /changes/:id/vote and asks
//    the parent to refetch.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VotePanel } from '@/app/(app)/changes/_components/vote-panel';
import type { ChangeRecord, ChangeVote } from '@/lib/changes';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});
const mockedApi = vi.mocked(api, true);

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const RAISER = '33333333-3333-3333-3333-333333333333';

function ballot(over: Partial<ChangeVote> & { id: string; voter_id: string }): ChangeVote {
  return { vote: null, reason: null, weight: 1, ad_hoc: false, decided_at: null, ...over };
}

function makeChange(over: Partial<ChangeRecord> = {}): ChangeRecord {
  const votes = over.votes ?? [ballot({ id: 'v1', voter_id: ME }), ballot({ id: 'v2', voter_id: OTHER })];
  const tally = over.cab_tally !== undefined
    ? over.cab_tally
    : {
        approve: votes.filter((v) => v.vote === 'approve').length,
        reject: votes.filter((v) => v.vote === 'reject').length,
        abstain: votes.filter((v) => v.vote === 'abstain').length,
        pending: votes.filter((v) => v.vote === null).length,
        cast: votes.filter((v) => v.vote !== null).length,
        roster: votes.length,
      };
  return {
    id: 'c1', title: 'Patch the edge firewall', change_type: 'normal', risk: 'high',
    status: 'cab_review', window_start: null, window_end: null,
    organization_id: 'org1', description: null, impact: 'high', likelihood: 'medium',
    implementation_plan: null, test_plan: null, backout_plan: null,
    created_by: RAISER, created_at: '2026-06-01T00:00:00.000Z',
    cab_board_id: 'b1', cab_quorum: 2, cab_quorum_requested: 2, cab_threshold: 'majority',
    vote_deadline: '2099-01-01T00:00:00.000Z',
    pir_outcome: null, pir_notes: null, pir_at: null,
    cab_steps: [], ...over, votes, cab_tally: tally,
  };
}

const votingControls = () => [
  screen.queryByRole('button', { name: /^approve$/i }),
  screen.queryByRole('button', { name: /^reject$/i }),
  screen.queryByRole('button', { name: /^abstain$/i }),
];

describe('VotePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the tally, roster and quorum progress from the API snapshot', () => {
    const change = makeChange({
      cab_quorum: 3,
      votes: [
        ballot({ id: 'v1', voter_id: ME, vote: 'approve' }),
        ballot({ id: 'v2', voter_id: OTHER, vote: 'reject', reason: 'no backout plan' }),
        ballot({ id: 'v3', voter_id: 'u4', vote: 'abstain' }),
        ballot({ id: 'v4', voter_id: 'u5' }),
      ],
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);

    const panel = screen.getByRole('region', { name: /cab vote/i });
    expect(within(panel).getByText('1 approve')).toBeInTheDocument();
    expect(within(panel).getByText('1 reject')).toBeInTheDocument();
    expect(within(panel).getByText('1 abstain')).toBeInTheDocument();
    expect(within(panel).getByText('1 pending')).toBeInTheDocument();

    // 3 of 4 cast against a quorum of 3.
    expect(within(panel).getByText(/quorum 3 of 3/i)).toBeInTheDocument();
    expect(within(panel).getByText(/roster 4/i)).toBeInTheDocument();
    expect(within(panel).getByText(/quorum met/i)).toBeInTheDocument();
    expect(within(panel).getByText(/simple majority of votes cast/i)).toBeInTheDocument();
    expect(within(panel).getByText(/no backout plan/)).toBeInTheDocument();
  });

  // The panel used to render "quorum met" beside "<threshold> of votes cast" while the
  // server's resolver was still holding the change open: `thresholdPasses` additionally
  // requires that NOTHING is pending under `unanimous`. A member was being told the vote
  // was decided when it was not.
  it('does not present a quorate unanimous vote as decided while a ballot is pending', () => {
    const change = makeChange({
      cab_quorum: 2,
      cab_threshold: 'unanimous',
      votes: [
        ballot({ id: 'v1', voter_id: ME, vote: 'approve' }),
        ballot({ id: 'v2', voter_id: OTHER, vote: 'approve' }),
        ballot({ id: 'v3', voter_id: 'u4' }),
      ],
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);
    const panel = screen.getByRole('region', { name: /cab vote/i });
    expect(within(panel).getByText(/unanimous — and every ballot must be cast/i)).toBeInTheDocument();
    expect(within(panel).getByText(/not yet decided/i)).toBeInTheDocument();
    expect(within(panel).getByText(/awaiting 1 more ballot/i)).toBeInTheDocument();
  });

  it('says quorum met plainly once the server would actually approve', () => {
    const change = makeChange({
      cab_quorum: 2,
      cab_threshold: 'unanimous',
      votes: [
        ballot({ id: 'v1', voter_id: ME, vote: 'approve' }),
        ballot({ id: 'v2', voter_id: OTHER, vote: 'approve' }),
      ],
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);
    const panel = screen.getByRole('region', { name: /cab vote/i });
    expect(within(panel).getByText(/quorum met/i)).toBeInTheDocument();
    expect(within(panel).queryByText(/not yet decided/i)).not.toBeInTheDocument();
  });

  it('does not count ad-hoc ballots toward quorum progress', () => {
    // The API measures quorum against the STANDING board only, so a panel that counted
    // ad-hoc ballots would show a board as quorate that the resolver does not.
    const change = makeChange({
      cab_quorum: 2,
      votes: [
        ballot({ id: 'v1', voter_id: ME, vote: 'approve' }),
        ballot({ id: 'v2', voter_id: OTHER, vote: 'approve', ad_hoc: true }),
      ],
      cab_tally: { approve: 2, reject: 0, abstain: 0, pending: 0, cast: 2, roster: 2, standing_cast: 1, standing_roster: 1 },
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);
    const panel = screen.getByRole('region', { name: /cab vote/i });
    expect(within(panel).getByText(/quorum 1 of 2/i)).toBeInTheDocument();
    expect(within(panel).queryByText(/quorum met/i)).not.toBeInTheDocument();
  });

  it('counts short of quorum rather than claiming it is met', () => {
    render(<VotePanel change={makeChange({ cab_quorum: 2 })} meId={ME} canVote onVoted={vi.fn()} />);
    expect(screen.getByText(/quorum 0 of 2/i)).toBeInTheDocument();
    expect(screen.getByText(/2 more votes needed/i)).toBeInTheDocument();
    expect(screen.queryByText(/quorum met/i)).not.toBeInTheDocument();
  });

  it('shows the voting controls to a member with a pending ballot', () => {
    render(<VotePanel change={makeChange()} meId={ME} canVote onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).toBeInTheDocument());
  });

  it('hides the voting controls from someone with no ballot on this change', () => {
    // A change.vote holder who is simply not on this change's roster.
    render(<VotePanel change={makeChange()} meId="nobody" canVote onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).not.toBeInTheDocument());
  });

  it('hides the voting controls from a viewer without change.vote', () => {
    render(<VotePanel change={makeChange()} meId={ME} canVote={false} onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).not.toBeInTheDocument());
  });

  it('hides the voting controls once the change has left cab_review', () => {
    render(<VotePanel change={makeChange({ status: 'approved' })} meId={ME} canVote onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).not.toBeInTheDocument());
  });

  it('replaces the controls with a re-cast affordance once the member has voted', async () => {
    const change = makeChange({
      votes: [ballot({ id: 'v1', voter_id: ME, vote: 'approve' }), ballot({ id: 'v2', voter_id: OTHER })],
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).not.toBeInTheDocument());

    // The API allows re-voting while the change is open, so the capability is reachable —
    // it just is not presented as an outstanding ballot.
    await userEvent.click(screen.getByRole('button', { name: /change vote/i }));
    votingControls().forEach((b) => expect(b).toBeInTheDocument());
  });

  it('states a clamped quorum instead of silently voting at the weaker rule', () => {
    // Board configured for 3; only 1 eligible voter survived recusal, so the API clamped
    // the effective quorum to 1. Without cab_quorum_requested this is invisible.
    const change = makeChange({
      cab_quorum: 1,
      cab_quorum_requested: 3,
      votes: [ballot({ id: 'v1', voter_id: ME })],
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);
    const note = screen.getByText(/quorum weakened/i);
    expect(note).toHaveTextContent(/configured for a quorum of 3/i);
    expect(note).toHaveTextContent(/quorum of 1/i);
  });

  it('says nothing about clamping when the board got the quorum it asked for', () => {
    render(<VotePanel change={makeChange({ cab_quorum: 2, cab_quorum_requested: 2 })} meId={ME} canVote onVoted={vi.fn()} />);
    expect(screen.queryByText(/quorum weakened/i)).not.toBeInTheDocument();
  });

  it('says nothing about clamping on a change that predates the persisted column', () => {
    render(<VotePanel change={makeChange({ cab_quorum: 1, cab_quorum_requested: null })} meId={ME} canVote onVoted={vi.fn()} />);
    expect(screen.queryByText(/quorum weakened/i)).not.toBeInTheDocument();
  });

  it('shows the raiser as recused rather than as a missing voter', () => {
    render(<VotePanel change={makeChange()} meId={ME} canVote onVoted={vi.fn()} />);
    expect(screen.getByText('Raiser')).toBeInTheDocument();
    expect(screen.getByText('recused')).toBeInTheDocument();
  });

  it('recuses the raiser from voting on their own change', () => {
    // The raiser has no ballot (the API never issues one), and is told why.
    render(<VotePanel change={makeChange()} meId={RAISER} canVote onVoted={vi.fn()} />);
    votingControls().forEach((b) => expect(b).not.toBeInTheDocument());
    expect(screen.getByText(/you raised this change, so you are recused/i)).toBeInTheDocument();
    expect(screen.getByText('You (raiser)')).toBeInTheDocument();
  });

  it('posts the vote with its reason and asks the parent to refetch', async () => {
    mockedApi.post.mockResolvedValue({ status: 'cab_review', tally: {}, quorum: 2, threshold: 'majority' });
    const onVoted = vi.fn();
    render(<VotePanel change={makeChange()} meId={ME} canVote onVoted={onVoted} />);

    await userEvent.type(screen.getByLabelText(/reason for your vote/i), 'backout plan checks out');
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(mockedApi.post).toHaveBeenCalledWith('/changes/c1/vote', {
      vote: 'approve',
      reason: 'backout plan checks out',
    });
    expect(onVoted).toHaveBeenCalled();
  });

  it('surfaces a rejected vote instead of silently swallowing it', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    mockedApi.post.mockRejectedValue(new ApiError(409, 'change is approved, not in CAB review'));
    render(<VotePanel change={makeChange()} meId={ME} canVote onVoted={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(await screen.findByText(/not in CAB review/i)).toBeInTheDocument();
  });

  it('names its units on a weighted board, where the totals are not head counts', () => {
    // tallyVotes sums WEIGHT. With a x3 chair the roster is 4 weight across 2 people, so
    // "roster 4" beside two visible rows reads as a bug unless the unit is stated.
    const change = makeChange({
      cab_quorum: 4,
      votes: [ballot({ id: 'v1', voter_id: ME, weight: 3 }), ballot({ id: 'v2', voter_id: OTHER })],
      // The server tally is weighted: 4 weight pending across 2 people.
      cab_tally: { approve: 0, reject: 0, abstain: 0, pending: 4, cast: 0, roster: 4 },
    });
    render(<VotePanel change={change} meId={ME} canVote onVoted={vi.fn()} />);

    expect(screen.getByText(/figures are vote weight, not head count/i)).toBeInTheDocument();
    expect(screen.getByText(/roster 4 weight/i)).toBeInTheDocument();
    expect(screen.getByText(/4 more weights needed/i)).toBeInTheDocument();
    expect(screen.getByText('×3')).toBeInTheDocument(); // the heavy ballot is identified
  });

  it('keeps plain vote wording on an ordinary one-member-one-vote board', () => {
    render(<VotePanel change={makeChange({ cab_quorum: 2 })} meId={ME} canVote onVoted={vi.fn()} />);
    expect(screen.getByText(/2 more votes needed/i)).toBeInTheDocument();
    expect(screen.queryByText(/vote weight, not head count/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
  });

  it('marks a vote past its deadline as overdue', () => {
    render(
      <VotePanel
        change={makeChange({ vote_deadline: '2020-01-01T00:00:00.000Z' })}
        meId={ME}
        canVote
        onVoted={vi.fn()}
      />,
    );
    expect(screen.getByText(/overdue since/i)).toBeInTheDocument();
  });
});
