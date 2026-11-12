'use client';
import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button, Field, Input } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';
import { SeverityBadge } from '@/components/ui/badges';
import { ApiError } from '@/lib/api';
import { RATING_FILL, ratingFor, risksApi, type FindingCandidate, type RiskSettings } from '@/lib/risks';

/** Per-organization appetite and tolerance. A governance decision, gated on risk.accept. */
export function AppetiteDialog({
  organizationId, settings, onClose, onSaved,
}: {
  organizationId: string | undefined;
  settings: RiskSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [appetite, setAppetite] = React.useState(settings.appetite_score);
  const [tolerance, setTolerance] = React.useState(settings.tolerance_score);
  const [days, setDays] = React.useState(settings.max_acceptance_days);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const invalid = appetite > tolerance;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await risksApi.putSettings(organizationId, { appetiteScore: appetite, toleranceScore: tolerance, maxAcceptanceDays: days });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  // Preview strip of every reachable 1-25 score, showing where the lines fall.
  const scores = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 20, 25];
  return (
    <Dialog title="Risk appetite" onClose={onClose} size="md"
      footer={<div className="flex items-center justify-between gap-2"><p className="text-xs text-danger">{error}</p><div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy || invalid}>{busy ? 'Saving…' : 'Save'}</Button></div></div>}>
      <p className="mb-4 text-sm text-muted">
        Residual risk above <strong className="text-fg">appetite</strong> is flagged for treatment. Above <strong className="text-fg">tolerance</strong> it needs leadership attention. These thresholds apply to this organization only.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Appetite (max residual score)"><Input type="number" min={1} max={25} value={appetite} onChange={(e) => setAppetite(Number(e.target.value))} /></Field>
        <Field label="Tolerance (max residual score)"><Input type="number" min={1} max={25} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} /></Field>
      </div>
      <Field label="Maximum acceptance lifetime (days)"><Input type="number" min={1} max={1095} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
      {invalid && <p className="mb-3 text-xs text-danger">Appetite cannot be higher than tolerance.</p>}
      <div className="flex gap-1" aria-label="Preview of thresholds across reachable scores" role="img">
        {scores.map((s) => (
          <div key={s} className="flex-1 text-center">
            <div className="h-6 rounded-sm text-[10px] font-semibold leading-6 text-fg" style={{ background: RATING_FILL[ratingFor(s)], outline: s > tolerance ? '1.5px dashed hsl(var(--danger))' : s > appetite ? '1.5px dashed hsl(var(--warning))' : undefined, outlineOffset: '-3px' }}>{s}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">Dashed amber: above appetite. Dashed red: above tolerance.</p>
    </Dialog>
  );
}

/** Raise risks from open high/critical posture findings not yet covered by a risk. */
export function FindingImportDialog({
  organizationId, onClose, onImported,
}: {
  organizationId: string | undefined;
  onClose: () => void;
  onImported: () => void;
}) {
  const [rows, setRows] = React.useState<FindingCandidate[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    risksApi.findingCandidates(organizationId).then(setRows).catch(() => setRows([]));
  }, [organizationId]);
  React.useEffect(load, [load]);

  async function raise(f: FindingCandidate) {
    setBusyId(f.id);
    setError(null);
    try {
      await risksApi.fromFinding(f.id);
      load();
      onImported();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not raise a risk');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog title="Raise risks from posture findings" onClose={onClose} size="lg" dismissOnBackdrop>
      <p className="mb-4 text-sm text-muted">Open critical and high findings with no risk yet. Each new risk starts with a score based on the finding&apos;s severity and links back to the finding.</p>
      {error && <p className="mb-3 text-xs text-danger" role="alert">{error}</p>}
      {!rows ? <Skeleton className="h-24" /> : rows.length === 0 ? (
        <EmptyState title="Every high-severity finding is covered" description="No open critical or high posture findings are missing a risk." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <SeverityBadge severity={f.severity} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">{f.title}</div>
                <div className="text-[11px] text-muted">{f.domain} · {f.status.replace(/_/g, ' ')}</div>
              </div>
              <Button size="sm" variant="outline" disabled={busyId === f.id} onClick={() => raise(f)}>{busyId === f.id ? '…' : 'Raise risk'}</Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
