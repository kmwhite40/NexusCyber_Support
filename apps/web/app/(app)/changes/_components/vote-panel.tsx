'use client';
// The CAB vote panel: tally, quorum progress, per-member ballots, and the
// Approve / Reject / Abstain controls. Backed by POST /changes/:id/vote.
//
// Two things this panel exists to make legible, because the API can only report them
// and the old detail pane buried both:
//
//  1. A CLAMPED quorum. The API clamps a board's configured quorum down to the eligible
//     roster so a shrunken board cannot deadlock; that weakens the board's own rule, so
//     the people voting see it stated, next to the number it replaced.
//  2. The RECUSED raiser. Whoever raised the change never gets a ballot (segregation of
//     duties), so without a row saying so the roster silently looks one person short.
import * as React from 'react';
import { Button, Badge, Textarea } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import {
  changesApi, quorumProgress, quorumClamp, isRecusedRaiser, ballotFor, isWeightedRoster,
  voteOutlook, THRESHOLD_RULE, type ChangeRecord, type ChangeVote, type VoteValue,
} from '@/lib/changes';

const VOTE_TONE = { approve: 'success', reject: 'danger', abstain: 'neutral' } as const;

function voterLabel(v: ChangeVote, meId: string | null | undefined) {
  if (meId && v.voter_id === meId) return 'You';
  return v.ad_hoc ? 'Ad-hoc reviewer' : 'Board member';
}

export function VotePanel({
  change,
  meId,
  canVote,
  onVoted,
}: {
  change: ChangeRecord;
  meId: string | null | undefined;
  /** Holds the `change.vote` permission. Board membership is checked separately. */
  canVote: boolean;
  /** Refetch the change after a successful vote. */
  onVoted: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<VoteValue | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [recasting, setRecasting] = React.useState(false);

  // A new server snapshot supersedes any in-progress local state.
  React.useEffect(() => {
    setBusy(null);
    setRecasting(false);
    setErr(null);
  }, [change.id, change.status, change.votes]);

  const tally = change.cab_tally;
  const progress = quorumProgress(tally, change.cab_quorum);
  // tallyVotes sums WEIGHT, so every figure below is weight units. On an unweighted board
  // that equals a head count and "votes" reads best; on a weighted one it does not, and
  // saying "votes" would leave the totals irreconcilable with the rows on screen.
  const weighted = isWeightedRoster(change.votes);
  const unit = weighted ? 'weight' : 'vote';
  const clamp = quorumClamp(change);
  const threshold = change.cab_threshold ?? 'majority';
  // What the SERVER's resolver would decide on this tally. The panel says "quorum met" only
  // as a fact about quorum, never as a verdict: under `unanimous` the server additionally
  // requires every ballot to be in, so a quorate, all-approve tally with one member still
  // to vote is not an approval and must not be shown as one.
  const outlook = voteOutlook(tally, change.cab_quorum, threshold);
  const open = change.status === 'cab_review';
  const myBallot = ballotFor(change.votes, meId);
  const iAmRaiser = isRecusedRaiser(change, meId);
  // "Pending ballot" is the gate for the controls: a roster row that has not been cast.
  // A member who already voted may still change it while the vote is open (the API
  // allows it), but must ask for the controls back rather than being shown them.
  const hasPendingBallot = !!myBallot && myBallot.vote === null;
  const mayAct = canVote && open && !iAmRaiser && !!myBallot;
  const showControls = mayAct && (hasPendingBallot || recasting);

  // The raiser is off the roster by design; say so instead of leaving a gap in the list.
  const raiserRecused = !!change.created_by && !change.votes.some((v) => v.voter_id === change.created_by);
  const deadline = change.vote_deadline ? new Date(change.vote_deadline) : null;
  const overdue = !!deadline && open && deadline.getTime() < Date.now();

  async function cast(vote: VoteValue) {
    setErr(null);
    setBusy(vote);
    try {
      await changesApi.vote(change.id, vote, reason.trim() || undefined);
      setReason('');
      onVoted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to record your vote');
    } finally {
      // Cleared here rather than waiting for the refetched change to land: if that
      // refetch fails the panel would otherwise stay disabled with no way back.
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-border p-3" aria-label="CAB vote">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">CAB vote</span>
        <span className="text-[11px] text-muted">
          {THRESHOLD_RULE[threshold]}
          {deadline && (
            <>
              {' · '}
              <span className={overdue ? 'text-warning' : undefined}>
                {overdue ? 'overdue since ' : 'closes '}
                {deadline.toLocaleString()}
              </span>
            </>
          )}
        </span>
      </div>

      {/* Tally */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone="success">{tally?.approve ?? 0} approve</Badge>
        <Badge tone="danger">{tally?.reject ?? 0} reject</Badge>
        <Badge tone="neutral">{tally?.abstain ?? 0} abstain</Badge>
        <Badge tone="warning">{tally?.pending ?? 0} pending</Badge>
        {weighted && <span className="text-[11px] text-muted">weighted board — figures are vote weight, not head count</span>}
      </div>

      {/* Quorum progress */}
      <div className="mt-2">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>
            Quorum {progress.cast} of {progress.quorum}
            {tally ? ` · roster ${tally.roster}${weighted ? ' weight' : ''}` : ''}
          </span>
          <span
            className={
              !progress.met || outlook.outcome === 'open' ? undefined
                : outlook.outcome === 'rejected' ? 'text-danger'
                : 'text-success'
            }
          >
            {!progress.met
              ? `${progress.remaining} more ${unit}${progress.remaining === 1 ? '' : 's'} needed`
              : outlook.outcome === 'open'
                ? `quorum met · not yet decided (${outlook.blocker})`
                // Quorum being met is not good news when the vote it resolved was a
                // rejection; a green "quorum met" chip on a rejected change reads as approval.
                : outlook.outcome === 'rejected'
                  ? 'quorum met · rejected'
                  : 'quorum met'}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
          <div
            className={`h-full rounded-full ${progress.met ? 'bg-success' : 'bg-brand'}`}
            style={{ width: `${progress.pct}%` }}
          />
        </div>
      </div>

      {clamp && (
        <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
          Quorum weakened: this board is configured for a quorum of {clamp.requested}, but only{' '}
          {clamp.effective} eligible {unit}{clamp.effective === 1 ? '' : 's'} {weighted ? 'was' : 'were'} on the
          roster when it was submitted, so the vote runs at a quorum of {clamp.effective}.
        </p>
      )}

      {/* Per-member status */}
      <ul className="mt-2 space-y-1">
        {change.votes.map((v) => (
          <li key={v.id} className="flex items-start justify-between gap-2 text-xs">
            <span className="min-w-0">
              <span className={meId && v.voter_id === meId ? 'font-medium text-fg' : 'text-muted'}>
                {voterLabel(v, meId)}
              </span>
              {(v.weight ?? 1) !== 1 && (
                <span className="ml-1 text-[11px] text-muted" title="This ballot counts as this much vote weight">
                  ×{v.weight}
                </span>
              )}
              {v.reason && <span className="block truncate text-[11px] text-muted">“{v.reason}”</span>}
            </span>
            <Badge tone={v.vote ? VOTE_TONE[v.vote] : 'warning'}>{v.vote ?? 'pending'}</Badge>
          </li>
        ))}
        {raiserRecused && (
          <li className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">{iAmRaiser ? 'You (raiser)' : 'Raiser'}</span>
            <Badge tone="accent" title="Segregation of duties: nobody votes on a change they raised">
              recused
            </Badge>
          </li>
        )}
      </ul>

      {/* Controls */}
      {showControls && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Textarea
            aria-label="Reason for your vote (optional)"
            placeholder="Reason (optional)"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy} onClick={() => cast('approve')}>
              {busy === 'approve' ? 'Recording…' : 'Approve'}
            </Button>
            <Button size="sm" variant="danger" disabled={!!busy} onClick={() => cast('reject')}>
              {busy === 'reject' ? 'Recording…' : 'Reject'}
            </Button>
            <Button size="sm" variant="subtle" disabled={!!busy} onClick={() => cast('abstain')}>
              {busy === 'abstain' ? 'Recording…' : 'Abstain'}
            </Button>
          </div>
        </div>
      )}

      {mayAct && !showControls && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
          <span>You voted {myBallot?.vote}.</span>
          <Button size="sm" variant="ghost" onClick={() => setRecasting(true)}>Change vote</Button>
        </div>
      )}

      {iAmRaiser && open && (
        <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted">
          You raised this change, so you are recused from voting on it.
        </p>
      )}

      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </section>
  );
}
