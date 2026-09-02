'use client';
// The change detail pane: identity + risk, the structured plans, the CAB vote, the
// deliberation thread, the post-implementation review, and the lifecycle actions.
//
// Permissions arrive as props rather than from useAuth() so this stays a plain
// presentational composition — the page owns the session, this owns the layout.
import * as React from 'react';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Select, Textarea, SegmentedControl } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/data';
import { ApiError } from '@/lib/api';
import { changesApi, statusTone, riskTone, type ChangeRecord, type PirOutcome, type ScheduleResult } from '@/lib/changes';
import { VotePanel } from './vote-panel';
import { ChangeComments } from './change-comments';

type PlanTab = 'implementation' | 'test' | 'backout';
const PLAN_TABS: ReadonlyArray<{ value: PlanTab; label: string }> = [
  { value: 'implementation', label: 'Implementation' },
  { value: 'test', label: 'Test' },
  { value: 'backout', label: 'Backout' },
];
const PIR_OUTCOMES: ReadonlyArray<{ value: PirOutcome; label: string }> = [
  { value: 'successful', label: 'Successful' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Failed' },
  { value: 'rolled_back', label: 'Rolled back' },
];

/** review -> closed is gated on a PIR, so `review` gets the PIR form, not an Advance button. */
const NEXT_IMPL: Record<string, 'implementing' | 'review' | 'closed'> = {
  scheduled: 'implementing',
  implementing: 'review',
};
const CANCELLABLE = new Set(['draft', 'cab_review', 'approved', 'scheduled']);

export interface ChangeDetailPerms {
  create: boolean;
  vote: boolean;
  implement: boolean;
}

export function ChangeDetail({
  change,
  meId,
  perms,
  onChanged,
}: {
  change: ChangeRecord | null;
  meId: string | null | undefined;
  perms: ChangeDetailPerms;
  /** Refetch the change and the list after any mutation. */
  onChanged: () => void;
}) {
  const [tab, setTab] = React.useState<PlanTab>('implementation');
  const [err, setErr] = React.useState<string | null>(null);
  const [pirOutcome, setPirOutcome] = React.useState<PirOutcome | ''>('');
  const [pirNotes, setPirNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // What scheduling actually reported. The API checks the window against the configured
  // freeze windows and returns the hits, but does NOT block — blackouts are advisory by
  // spec. Discarding the result made them advisory to nobody: an admin could configure a
  // freeze window in CAB settings and watch changes get scheduled straight through it with
  // no sign anywhere. So the scheduler is told, and the change is still scheduled.
  const [sched, setSched] = React.useState<ScheduleResult | null>(null);

  const changeId = change?.id;
  React.useEffect(() => {
    setErr(null);
    setPirOutcome('');
    setPirNotes('');
    setSched(null);
  }, [changeId]);

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function schedule(id: string) {
    setErr(null);
    setBusy(true);
    try {
      const start = new Date(Date.now() + 86400000);
      start.setUTCHours(2, 0, 0, 0);
      const end = new Date(start.getTime() + 2 * 3600000);
      setSched(await changesApi.schedule(id, start.toISOString(), end.toISOString()));
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to schedule the change');
    } finally {
      setBusy(false);
    }
  }

  if (!change) {
    return (
      <Card>
        <CardHeader><CardTitle>Select a change</CardTitle></CardHeader>
        <CardBody>
          <EmptyState title="Nothing selected" description="Pick a change from the list." />
        </CardBody>
      </Card>
    );
  }

  const plan =
    tab === 'implementation' ? change.implementation_plan
      : tab === 'test' ? change.test_plan
      : change.backout_plan;
  const next = NEXT_IMPL[change.status];

  return (
    <Card>
      <CardHeader><CardTitle>Change detail</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <div>
          <div className="text-sm font-medium text-fg">{change.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{change.change_type}</Badge>
            <Badge tone={statusTone(change.status)}>{change.status.replace(/_/g, ' ')}</Badge>
            <Badge
              tone={riskTone(change.risk)}
              title={
                change.impact && change.likelihood
                  ? `Derived from ${change.impact} impact × ${change.likelihood} likelihood`
                  : 'Risk was set directly; impact and likelihood are not recorded'
              }
            >
              {change.risk} risk
            </Badge>
          </div>
          {change.impact && change.likelihood && (
            <p className="mt-1 text-[11px] text-muted">
              {change.impact} impact × {change.likelihood} likelihood
            </p>
          )}
        </div>

        {change.description && <p className="whitespace-pre-wrap text-xs text-fg/80">{change.description}</p>}

        {/* Structured plans */}
        <div className="space-y-2">
          <SegmentedControl<PlanTab> size="sm" value={tab} onChange={setTab} options={PLAN_TABS} />
          <div className="rounded-md border border-border p-2">
            {plan ? (
              <p className="whitespace-pre-wrap text-xs text-fg/80">{plan}</p>
            ) : (
              <p className="text-xs text-muted">No {tab} plan recorded for this change.</p>
            )}
          </div>
        </div>

        {change.votes.length === 0 && change.cab_steps.length > 0 && (
          // Pre-voting changes approved through approvals/approval_steps.
          <div className="rounded-md border border-border p-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">CAB board (legacy approval)</div>
            {change.cab_steps.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-xs">
                <span className="text-muted">approver</span>
                <Badge tone={s.decision === 'approved' ? 'success' : s.decision === 'rejected' ? 'danger' : 'neutral'}>{s.decision ?? 'pending'}</Badge>
              </div>
            ))}
          </div>
        )}

        {change.votes.length > 0 && (
          <VotePanel change={change} meId={meId} canVote={perms.vote} onVoted={onChanged} />
        )}

        {/* Post-implementation review */}
        {change.pir_outcome && (
          <div className="rounded-md border border-border p-2 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Post-implementation review</span>
              <Badge tone={change.pir_outcome === 'successful' ? 'success' : change.pir_outcome === 'partial' ? 'warning' : 'danger'}>
                {change.pir_outcome.replace(/_/g, ' ')}
              </Badge>
            </div>
            {change.pir_notes && <p className="whitespace-pre-wrap text-fg/80">{change.pir_notes}</p>}
          </div>
        )}

        {change.status === 'review' && perms.implement && (
          <div className="space-y-2 rounded-md border border-border p-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Post-implementation review
            </div>
            <p className="text-[11px] text-muted">A PIR is required before this change can close.</p>
            <Select
              aria-label="Post-implementation review outcome"
              value={pirOutcome}
              onChange={(e) => setPirOutcome(e.target.value as PirOutcome | '')}
            >
              <option value="">Select an outcome…</option>
              {PIR_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Textarea
              aria-label="Post-implementation review notes"
              placeholder="What happened? (optional)"
              rows={2}
              value={pirNotes}
              onChange={(e) => setPirNotes(e.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || !pirOutcome}
              onClick={() => pirOutcome && run(
                () => changesApi.pir(change.id, pirOutcome, pirNotes.trim() || undefined),
                'Failed to record the review',
              )}
            >
              Record review &amp; close
            </Button>
          </div>
        )}

        <ChangeComments changeId={change.id} canPost={perms.create || perms.vote} />

        {/* Lifecycle */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {change.status === 'draft' && perms.create && (
            // The standing board (GET/PUT /cab/board) supplies the roster. The raiser is
            // NEVER added as their own voter — segregation of duties; the API recuses them.
            // A memberless board therefore fails loudly here, which is the correct signal
            // to go configure one. Standard changes auto-approve and ignore the roster.
            <Button size="sm" disabled={busy} onClick={() => run(() => changesApi.submitCab(change.id), 'Failed to submit to the CAB')}>
              Submit to CAB
            </Button>
          )}
          {change.status === 'approved' && perms.implement && (
            <Button size="sm" disabled={busy} onClick={() => schedule(change.id)}>
              Schedule (tomorrow 02:00)
            </Button>
          )}
          {next && perms.implement && (
            <Button size="sm" variant="subtle" disabled={busy} onClick={() => run(() => changesApi.transition(change.id, next), `Failed to move the change to ${next}`)}>
              Advance to {next}
            </Button>
          )}
          {CANCELLABLE.has(change.status) && (perms.implement || (!!meId && change.created_by === meId)) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => changesApi.cancel(change.id), 'Failed to cancel the change')}>
              Cancel change
            </Button>
          )}
        </div>

        {sched && sched.blackouts.length > 0 && (
          <p role="status" className="rounded border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
            Scheduled inside a change freeze: {sched.blackouts.map((b) => b.name).join(', ')}. Blackout windows are
            advisory, so the change was still scheduled — move the window or record why the freeze does not apply.
          </p>
        )}
        {sched && sched.conflicts.length > 0 && (
          <p role="status" className="rounded border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
            Overlaps {sched.conflicts.length} other scheduled change{sched.conflicts.length === 1 ? '' : 's'} in this
            organization.
          </p>
        )}

        {err && <p className="text-xs text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}
