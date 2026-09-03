'use client';
// Ticket-detail provisioning panel: the human checkpoint in front of live Entra/Windows 365
// directory writes. Preview is a pure dry run (Task 15's provisioning.preview) — it must be
// safe to click any number of times. Provision is the one irreversible action on this page, so
// it stays disabled while the previewed plan carries any blocker, and a careless double-click
// is caught server-side (409) as well as pre-empted here once a run is known to be in flight.
//
// Never render a credential: the execute response deliberately carries no Temporary Access
// Pass or password (see apps/api/src/modules/provisioning/index.ts), and nothing in this file
// logs the response — do not add a console.log/console.error of it, and do not add a field to
// either type below that the API does not already return.
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';
import { AlertTriangle, Clock3, Info } from 'lucide-react';

interface Blocker { code: string; message: string }
interface PlanStep { key: string; label: string; detail: Record<string, unknown> }
interface Plan {
  upn: string;
  displayName: string;
  steps: PlanStep[];
  blockers: Blocker[];
  /** Binds this exact preview to the run it authorises — see provision() below. */
  fingerprint: string;
}
interface StepOutcome { key: string; status: string; error?: string }
interface ExecuteResult { runId: string; status: string; outcomes: StepOutcome[] }
interface RunRow {
  id: string;
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  steps: Array<{ step_key: string; status: string; error: string | null }>;
}

/** Run statuses that mean a run is still in flight — mirrors provisioning/index.ts's
 *  IN_FLIGHT_RUN_STATUSES. `awaiting_cloudpc` belongs here: the Cloud PC build is a normal
 *  30-90 minute wait, not a failure, and a second run must not be startable while one is
 *  already claiming this ticket's identity. */
const IN_FLIGHT_STATUSES = new Set(['running', 'awaiting_cloudpc']);

function runToneAndLabel(status: string): { tone: 'brand' | 'warning' | 'success' | 'danger' | 'neutral'; label: string } {
  switch (status) {
    case 'awaiting_cloudpc': return { tone: 'warning', label: 'Awaiting Cloud PC' };
    case 'running': return { tone: 'brand', label: 'Running' };
    case 'succeeded': return { tone: 'success', label: 'Succeeded' };
    case 'failed': return { tone: 'danger', label: 'Failed' };
    default: return { tone: 'neutral', label: status };
  }
}

function stepToneAndLabel(status: string): { tone: 'brand' | 'warning' | 'success' | 'danger' | 'neutral'; label: string } {
  switch (status) {
    case 'succeeded': return { tone: 'success', label: 'done' };
    case 'failed': return { tone: 'danger', label: 'failed' };
    case 'skipped': return { tone: 'neutral', label: 'skipped' };
    case 'running': return { tone: 'brand', label: 'running' };
    default: return { tone: 'neutral', label: status };
  }
}

export function ProvisioningPanel({ ticketId, canProvision }: { ticketId: string; canProvision: boolean }) {
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const [executing, setExecuting] = React.useState(false);
  const [executeError, setExecuteError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ExecuteResult | null>(null);

  const [latestRun, setLatestRun] = React.useState<RunRow | null>(null);
  const [runsLoaded, setRunsLoaded] = React.useState(false);
  /** null = not yet known. See featureOff below for why the distinction is deliberate. */
  const [enabled, setEnabled] = React.useState<boolean | null>(null);

  const loadRuns = React.useCallback(() => {
    api
      .get<{ data: RunRow[]; provisioningEnabled?: boolean }>(`/tickets/${ticketId}/provisioning`)
      .then((r) => {
        setLatestRun(r.data[0] ?? null);
        setEnabled(r.provisioningEnabled ?? null);
      })
      .catch(() => {
        /* Run history is a convenience read; a failure here must not block the panel from
           rendering the preview/provision controls. */
      })
      .finally(() => setRunsLoaded(true));
  }, [ticketId]);

  React.useEffect(() => {
    if (!canProvision) return;
    loadRuns();
  }, [canProvision, loadRuns]);

  if (!canProvision) return null;

  const blocked = (plan?.blockers.length ?? 0) > 0;
  // Only an explicit `false` hides the controls. If the flag never arrived — an older API, or
  // the loadRuns read failing — we do NOT claim the feature is off: we fall back to the old
  // behaviour and let the server be the one to refuse. Announcing "not configured" on the
  // strength of a request that failed would be inventing an answer we do not have.
  const featureOff = enabled === false;
  // Once a run is known to be in flight (from history, or from a just-started execute call),
  // Provision stays disabled — this is the pre-emptive half of the 409 guard; the reactive half
  // is the catch block in execute() below, for the race where two admins click at once.
  const inFlight = Boolean(latestRun && IN_FLIGHT_STATUSES.has(latestRun.status));

  async function preview() {
    setPreviewing(true);
    setPlanError(null);
    setExecuteError(null);
    setResult(null);
    try {
      // Routes wrap every payload as `{ data: ... }` (apps/api/src/http/routes.ts); api.post()
      // returns the raw parsed body, unwrapped nowhere in lib/api.ts, so the generic here must
      // model the envelope — claiming <Plan> directly would compile fine and still be wrong.
      const res = await api.post<{ data: Plan }>(`/tickets/${ticketId}/provisioning/preview`);
      setPlan(res.data);
    } catch (e) {
      setPlan(null);
      setPlanError(e instanceof ApiError ? e.detail : 'Could not build a provisioning preview.');
    } finally {
      setPreviewing(false);
    }
  }

  async function provision() {
    setExecuting(true);
    setExecuteError(null);
    try {
      // The fingerprint of the plan RENDERED ABOVE, which is the plan the admin just read. The
      // server rebuilds the plan from current data and refuses (412) unless it still hashes to
      // this — so an answer edited, a group renamed or a licence pool exhausted between Preview
      // and Provision stops the run instead of quietly changing what gets created.
      const res = await api.post<{ data: ExecuteResult }>(
        `/tickets/${ticketId}/provisioning/execute`,
        { fingerprint: plan?.fingerprint },
      );
      setResult(res.data);
      // The plan that was approved has now been acted on; drop it so a stale "Provision" button
      // can't be clicked again without a fresh preview of current tenant state.
      setPlan(null);
      loadRuns();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        // The previewed plan no longer matches what would be created. Drop it, so the only way
        // forward is a fresh Preview the admin has to read and approve again.
        setPlan(null);
        setExecuteError('The plan changed since you previewed it, so nothing was provisioned. Preview again and review the new plan before provisioning.');
      } else if (e instanceof ApiError && e.status === 409) {
        setExecuteError('A provisioning run is already in progress for this ticket. Wait for it to finish before starting another.');
      } else {
        setExecuteError(e instanceof ApiError ? e.detail : 'Provisioning failed to start.');
      }
      // Either way, our view of "is a run in flight" may be stale — resync from the server.
      loadRuns();
    } finally {
      setExecuting(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Provisioning</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        {runsLoaded && latestRun && (
          <RunStatus run={latestRun} />
        )}

        {featureOff && (
          <div className="rounded-md border border-border bg-surface-2/40 p-3">
            <p className="flex items-start gap-1.5 text-sm text-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span>
                Provisioning is not configured on this deployment, so no account can be created
                from this ticket. Complete the fulfillment steps manually, or ask an
                administrator to finish the tenant setup before using this panel.
              </span>
            </p>
          </div>
        )}

        {!result && !featureOff && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={preview} disabled={previewing || executing}>
              {previewing ? 'Building preview…' : plan ? 'Refresh preview' : 'Preview'}
            </Button>
            {inFlight && !plan && (
              <span className="text-xs text-muted">A run is already in progress — preview reflects current tenant state, but Provision stays disabled until it finishes.</span>
            )}
          </div>
        )}

        {planError && <p className="text-sm text-danger">{planError}</p>}

        {plan && !result && (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Will create <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{plan.upn}</code> ({plan.displayName})
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-fg/90">
              {plan.steps.map((s) => <li key={s.key}>{s.label}</li>)}
            </ol>

            {blocked && (
              <div id="provisioning-blockers" className="rounded-md border border-danger/30 bg-danger/10 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-danger">
                  <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
                  This run cannot proceed
                </div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-danger/90">
                  {plan.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={provision}
                // No plan in hand means no fingerprint to send, and the server refuses an
                // execute with no fingerprint. Mirror that here so the button never issues a
                // request that cannot succeed.
                disabled={executing || blocked || inFlight || !plan.fingerprint}
                aria-describedby={blocked ? 'provisioning-blockers' : undefined}
              >
                {executing ? 'Provisioning…' : 'Provision'}
              </Button>
              {inFlight && !blocked && (
                <span className="text-xs text-warning">A provisioning run is already in progress for this ticket.</span>
              )}
            </div>
          </div>
        )}

        {executeError && <p className="text-sm text-danger">{executeError}</p>}

        {result && <ExecuteOutcome result={result} />}
      </CardBody>
    </Card>
  );
}

function RunStatus({ run }: { run: RunRow }) {
  const { tone, label } = runToneAndLabel(run.status);
  return (
    <div className="rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Latest run</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {run.status === 'awaiting_cloudpc' && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          The directory account and licenses are in place; Windows 365 is still building the Cloud PC. This
          routinely takes 30–90 minutes and finishes on its own — no action needed here.
        </p>
      )}
      {run.status === 'failed' && run.error && (
        <p className="mt-1.5 text-xs text-danger">{run.error}</p>
      )}
      {run.steps.length > 0 && <StepList steps={run.steps.map((s) => ({ key: s.step_key, status: s.status, error: s.error ?? undefined }))} />}
    </div>
  );
}

function ExecuteOutcome({ result }: { result: ExecuteResult }) {
  const { tone, label } = runToneAndLabel(result.status);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-fg">Run status</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {result.status === 'awaiting_cloudpc' && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          The directory account and licenses are in place; Windows 365 is still building the Cloud PC. This
          routinely takes 30–90 minutes and finishes on its own — no action needed here.
        </p>
      )}
      <StepList steps={result.outcomes} />
    </div>
  );
}

function StepList({ steps }: { steps: StepOutcome[] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {steps.map((s) => {
        const { tone, label } = stepToneAndLabel(s.status);
        return (
          <li key={s.key} className="flex items-center gap-2">
            <Badge tone={tone}>{label}</Badge>
            <span className="text-fg/90">{s.key.replace(/_/g, ' ')}</span>
            {s.error && <span className="text-danger">— {s.error}</span>}
          </li>
        );
      })}
    </ul>
  );
}
