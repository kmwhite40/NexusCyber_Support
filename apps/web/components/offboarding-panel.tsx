'use client';
// Ticket-detail offboarding panel: the human checkpoint in front of a live Entra teardown.
//
// Preview is a pure dry run — it reads tenant state and writes nothing, so it is safe to click
// any number of times. Schedule is the consequential action, and it does NOT execute: it arms an
// approved plan to fire at the instant HR named. The sweeper does the writing.
//
// Two things this panel must never soften:
//  - The mailbox conversion is a MANUAL step. Graph has no conversion endpoint, and everything
//    after it depends on it having happened, so it is labelled rather than quietly skipped.
//  - A privileged account carries a 7-year retention obligation, not the 1-year default. Whoever
//    arms the run should not have to infer that from the step list.
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input } from '@/components/ui/primitives';
import { localInputToIsoInstant } from '@/components/dynamic-form-field';
import { AlertTriangle, Info, ShieldAlert, Clock3 } from 'lucide-react';

interface Blocker { code: string; message: string }
interface PlanStep { key: string; label: string; manual: boolean; detail: Record<string, unknown> }
interface Plan {
  upn: string;
  currentDisplayName: string;
  inactiveName: string;
  privileged: boolean;
  steps: PlanStep[];
  blockers: Blocker[];
  /** Binds this exact preview to the run it authorises. */
  fingerprint: string;
}
interface RunRow {
  id: string;
  status: string;
  error: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  steps: Array<{ step_key: string; status: string; error: string | null }>;
}

function runTone(status: string): { tone: 'brand' | 'warning' | 'success' | 'danger' | 'neutral'; label: string } {
  switch (status) {
    case 'scheduled': return { tone: 'brand', label: 'Scheduled' };
    case 'running': return { tone: 'brand', label: 'Running' };
    case 'needs_review': return { tone: 'warning', label: 'Needs review' };
    case 'succeeded': return { tone: 'success', label: 'Succeeded' };
    case 'cancelled': return { tone: 'neutral', label: 'Cancelled' };
    case 'failed': return { tone: 'danger', label: 'Failed' };
    default: return { tone: 'neutral', label: status };
  }
}

export function OffboardingPanel({ ticketId, canOffboard }: { ticketId: string; canOffboard: boolean }) {
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const [scheduling, setScheduling] = React.useState(false);
  const [scheduleError, setScheduleError] = React.useState<string | null>(null);
  const [scheduledLocal, setScheduledLocal] = React.useState('');
  const [armed, setArmed] = React.useState<{ scheduledFor: string } | null>(null);

  const [cancelReason, setCancelReason] = React.useState('');
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  const [latestRun, setLatestRun] = React.useState<RunRow | null>(null);
  const [runsLoaded, setRunsLoaded] = React.useState(false);
  /** null = not yet known; only an explicit false hides the controls. */
  const [enabled, setEnabled] = React.useState<boolean | null>(null);

  const loadRuns = React.useCallback(() => {
    api
      .get<{ data: RunRow[]; offboardingEnabled?: boolean }>(`/tickets/${ticketId}/offboarding`)
      .then((r) => {
        setLatestRun(r.data[0] ?? null);
        setEnabled(r.offboardingEnabled ?? null);
      })
      .catch(() => {
        /* Run history is a convenience read; a failure must not block the controls. */
      })
      .finally(() => setRunsLoaded(true));
  }, [ticketId]);

  React.useEffect(() => {
    if (!canOffboard) return;
    loadRuns();
  }, [canOffboard, loadRuns]);

  if (!canOffboard) return null;

  const blocked = (plan?.blockers.length ?? 0) > 0;
  const featureOff = enabled === false;

  async function preview() {
    setPreviewing(true);
    setPlanError(null);
    setScheduleError(null);
    setArmed(null);
    try {
      // Routes wrap every payload as `{ data: ... }` and api.post returns the raw body, so the
      // generic must model the envelope — claiming <Plan> compiles fine and is still wrong.
      const res = await api.post<{ data: Plan }>(`/tickets/${ticketId}/offboarding/preview`);
      setPlan(res.data);
    } catch (e) {
      setPlan(null);
      setPlanError(e instanceof ApiError ? e.detail : 'Could not build an offboarding preview.');
    } finally {
      setPreviewing(false);
    }
  }

  async function schedule() {
    setScheduling(true);
    setScheduleError(null);
    try {
      const res = await api.post<{ data: { runId: string; scheduledFor: string } }>(
        `/tickets/${ticketId}/offboarding/schedule`,
        { fingerprint: plan?.fingerprint, scheduledFor: localInputToIsoInstant(scheduledLocal) },
      );
      setArmed({ scheduledFor: res.data.scheduledFor });
      // The approved plan has been armed; drop it so a stale one cannot be re-submitted without
      // a fresh preview of current tenant state.
      setPlan(null);
      loadRuns();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        setPlan(null);
        setScheduleError('The plan changed since you previewed it, so nothing was scheduled. Preview again and review the new plan before scheduling.');
      } else {
        setScheduleError(e instanceof ApiError ? e.detail : 'Could not schedule the offboarding.');
      }
      loadRuns();
    } finally {
      setScheduling(false);
    }
  }

  async function cancelRun() {
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await api.post<{ data: { cancelled: number } }>(
        `/tickets/${ticketId}/offboarding/cancel`, { reason: cancelReason },
      );
      // cancelled: 0 means the run had already fired — the endpoint only touches runs still
      // 'scheduled'. Saying nothing here let a tech believe the termination was called back
      // while the account was already disabled and renamed. That is the worst thing this panel
      // could get wrong, so it is said plainly.
      if (res.data.cancelled === 0) {
        setCancelError('Nothing to cancel — this run had already started. The account may already be disabled; check the run status below.');
      } else {
        setCancelReason('');
        // The armed banner describes a run that no longer exists; clearing it also brings the
        // Preview control back, which is otherwise hidden while `armed` is set.
        setArmed(null);
      }
      loadRuns();
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.detail : 'Could not cancel the scheduled run.');
    } finally {
      setCancelling(false);
    }
  }

  /** A run persisted as scheduled — distinct from `armed`, which is this session's own result. */
  const runIsArmed = latestRun?.status === 'scheduled';

  return (
    <Card>
      <CardHeader><CardTitle>Offboarding</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        {runsLoaded && latestRun && <RunStatus run={latestRun} />}

        {runIsArmed && (
          <div className="space-y-2 rounded-md border border-border bg-surface-2/40 p-3">
            <p className="text-xs text-muted">
              This run is armed and will fire on its own. Stop it here if the departure has
              changed — there is no other way to call it back.
            </p>
            <Input
              placeholder="Why is this being cancelled?"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={cancelRun}
                // A reason is required: the run history is the record of why a termination did
                // not happen, and "cancelled" with no reason is the least useful entry it could
                // hold.
                disabled={cancelling || !cancelReason.trim()}
              >
                {cancelling ? 'Cancelling…' : 'Cancel run'}
              </Button>
            </div>
            {cancelError && <p className="text-sm text-danger">{cancelError}</p>}
          </div>
        )}

        {featureOff && (
          <div className="rounded-md border border-border bg-surface-2/40 p-3">
            <p className="flex items-start gap-1.5 text-sm text-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span>
                Offboarding is not configured on this deployment, so no directory changes can be
                made from this ticket. Complete the runbook steps manually, or ask an
                administrator to finish the tenant setup.
              </span>
            </p>
          </div>
        )}

        {!armed && !featureOff && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={preview} disabled={previewing || scheduling}>
              {previewing ? 'Building preview…' : plan ? 'Refresh preview' : 'Preview'}
            </Button>
          </div>
        )}

        {planError && <p className="text-sm text-danger">{planError}</p>}

        {plan && !armed && (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Will disable <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{plan.upn}</code>
              {' '}and rename it to{' '}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{plan.inactiveName}</code>
            </p>

            {plan.privileged && (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <p className="flex items-start gap-1.5 text-sm text-warning">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span>
                    This is a <strong>privileged</strong> account. It must be retained for 7 years
                    rather than the standard 1 year.
                  </span>
                </p>
              </div>
            )}

            <ol className="list-decimal space-y-1 pl-5 text-sm text-fg/90">
              {plan.steps.map((s) => (
                <li key={s.key}>
                  {s.label}
                  {s.manual && (
                    <Badge tone="warning" className="ml-2">manual</Badge>
                  )}
                </li>
              ))}
            </ol>

            {blocked && (
              <div id="offboarding-blockers" className="rounded-md border border-danger/30 bg-danger/10 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-danger">
                  <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
                  This run cannot proceed
                </div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-danger/90">
                  {plan.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
                </ul>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-medium text-muted" htmlFor="offboarding-when">
                Disable at (the date and time HR instructed)
              </label>
              <Input
                id="offboarding-when"
                type="datetime-local"
                value={scheduledLocal}
                onChange={(e) => setScheduledLocal(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  // Danger, because this ARMS an account teardown. It previously looked identical
                  // to "Send" — the most irreversible control in the product styled as the most
                  // ordinary one.
                  variant="danger"
                  onClick={schedule}
                  // No instant means no schedule. Defaulting to "now" on a termination is not a
                  // default anyone should get by omission.
                  disabled={scheduling || blocked || !scheduledLocal || !plan.fingerprint}
                  aria-describedby={blocked ? 'offboarding-blockers' : undefined}
                >
                  {scheduling ? 'Scheduling…' : 'Schedule'}
                </Button>
                <span className="text-xs text-muted">
                  Nothing is changed until this moment arrives.
                </span>
              </div>
            </div>
          </div>
        )}

        {scheduleError && <p className="text-sm text-danger">{scheduleError}</p>}

        {armed && (
          <div className="rounded-md border border-border bg-surface-2/40 p-3">
            <p className="flex items-start gap-1.5 text-sm text-fg">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={1.75} />
              <span>
                Armed for <strong>{new Date(armed.scheduledFor).toLocaleString()}</strong>. Sign-in
                is blocked and sessions revoked at that moment; the mailbox conversion still needs
                doing by hand.
              </span>
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RunStatus({ run }: { run: RunRow }) {
  const { tone, label } = runTone(run.status);
  return (
    <div className="rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Latest run</span>
        <Badge tone={tone}>{label}</Badge>
        {run.scheduled_for && run.status === 'scheduled' && (
          <span className="text-xs text-muted">fires {new Date(run.scheduled_for).toLocaleString()}</span>
        )}
      </div>
      {run.error && (
        <p className={`mt-1.5 text-xs ${run.status === 'failed' ? 'text-danger' : 'text-muted'}`}>
          {run.error}
        </p>
      )}
      {run.steps.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {run.steps.map((s) => (
            <li key={s.step_key} className="flex items-center gap-2">
              <Badge tone={s.status === 'succeeded' ? 'success' : s.status === 'failed' ? 'danger' : 'neutral'}>
                {s.status}
              </Badge>
              <span className="text-fg/90">{s.step_key.replace(/_/g, ' ')}</span>
              {s.error && <span className="text-danger">— {s.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
