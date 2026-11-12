'use client';
// One risk, end to end: statement, three-point score trail, appetite position, FAIR exposure,
// treatment plan (POA&M), evidence links, acceptance workflow and assessment history.
import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Button, Input, Select, SegmentedControl, Textarea } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';
import { Sparkline } from '@/components/ui/charts';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { humanize, money, risksApi, type LinkKind, type RiskDetail, type RiskStatus } from '@/lib/risks';
import { RatingBadge, ScoreChip, ScoreTrail } from './matrix';

type Tab = 'overview' | 'treatment' | 'links' | 'acceptance' | 'history';

const NEXT: Record<RiskStatus, RiskStatus[]> = {
  identified: ['assessed', 'closed'],
  assessed: ['treating', 'monitoring', 'closed'],
  treating: ['monitoring', 'assessed', 'closed'],
  monitoring: ['treating', 'assessed', 'closed'],
  accepted: ['assessed', 'treating', 'closed'],
  closed: ['identified'],
};

export function AppetiteBadge({ state }: { state: RiskDetail['appetite_state'] }) {
  if (state === 'above_tolerance') return <Badge tone="danger">Above tolerance</Badge>;
  if (state === 'above_appetite') return <Badge tone="warning">Above appetite</Badge>;
  return <Badge tone="success">Within appetite</Badge>;
}

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString() : '—');

export function RiskDetailDialog({
  riskId, onClose, onEdit, onChanged, canManage, canAccept, meId,
}: {
  riskId: string;
  onClose: () => void;
  onEdit: (r: RiskDetail) => void;
  onChanged: () => void;
  canManage: boolean;
  canAccept: boolean;
  meId: string | undefined;
}) {
  const [r, setR] = React.useState<RiskDetail | null>(null);
  const [tab, setTab] = React.useState<Tab>('overview');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    risksApi.get(riskId).then(setR).catch((e) => setError(e instanceof ApiError ? e.detail : 'Could not load the risk'));
  }, [riskId]);
  React.useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? (e.errors?.map((x) => x.message).join('; ') || e.detail) : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={r ? `${r.ref} · ${r.title}` : 'Risk'} onClose={onClose} size="xl" dismissOnBackdrop>
      {!r ? (
        error ? <p className="text-sm text-danger">{error}</p> : <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-48" /></div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <RatingBadge rating={r.residual_rating} score={r.residual_score} />
            <AppetiteBadge state={r.appetite_state} />
            <Badge tone="brand">{humanize(r.status)}</Badge>
            <Badge>{humanize(r.category)}</Badge>
            {r.strategy && <Badge tone="accent">{humanize(r.strategy)}</Badge>}
            {r.review_overdue && <Badge tone="warning">Review overdue</Badge>}
            {r.acceptance_status === 'requested' && <Badge tone="warning">Acceptance pending</Badge>}
            <div className="ml-auto flex flex-wrap gap-2">
              {canManage && (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => risksApi.review(r.id))}>Mark reviewed</Button>
                  <Select className="h-8 w-40 text-xs" value="" aria-label="Move to status" disabled={busy}
                    onChange={(e) => { const to = e.target.value as RiskStatus; if (to) act(() => risksApi.transition(r.id, to)); }}>
                    <option value="">Move to…</option>
                    {(NEXT[r.status] ?? []).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </Select>
                  <Button size="sm" onClick={() => onEdit(r)}>Reassess</Button>
                </>
              )}
            </div>
          </div>
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}

          <SegmentedControl<Tab> size="sm" value={tab} onChange={setTab} options={[
            { value: 'overview', label: 'Overview' },
            { value: 'treatment', label: `Treatment${r.treatments.length ? ` · ${r.treatments.length}` : ''}` },
            { value: 'links', label: `Evidence${r.links.length ? ` · ${r.links.length}` : ''}` },
            { value: 'acceptance', label: 'Acceptance' },
            { value: 'history', label: 'History' },
          ]} />

          {tab === 'overview' && <Overview r={r} />}
          {tab === 'treatment' && <TreatmentTab r={r} canManage={canManage} act={act} busy={busy} />}
          {tab === 'links' && <LinksTab r={r} canManage={canManage} act={act} busy={busy} />}
          {tab === 'acceptance' && <AcceptanceTab r={r} canManage={canManage} canAccept={canAccept} meId={meId} act={act} busy={busy} />}
          {tab === 'history' && <HistoryTab r={r} />}
        </div>
      )}
    </Dialog>
  );
}

function Overview({ r }: { r: RiskDetail }) {
  const hasStatement = r.cause || r.event || r.consequence;
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        {hasStatement && (
          <blockquote className="rounded-lg border border-border bg-surface-2/50 p-4 text-sm leading-relaxed text-fg">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-widest text-muted">Risk statement</span>
            {r.cause && <>Because of <strong>{r.cause}</strong>, </>}
            {r.event && <><strong>{r.event}</strong> may occur</>}
            {r.consequence && <>, leading to <strong>{r.consequence}</strong></>}.
          </blockquote>
        )}
        {r.description && <p className="whitespace-pre-wrap text-sm text-muted">{r.description}</p>}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Item label="Owner" value={r.owner?.name ?? r.owner_name ?? '—'} />
          <Item label="Threat source" value={humanize(r.threat_source)} />
          <Item label="Velocity" value={humanize(r.velocity)} />
          <Item label="Last reviewed" value={fmtDate(r.last_reviewed_at)} />
          <Item label="Next review" value={<span className={cn(r.review_overdue && 'text-warning')}>{fmtDate(r.next_review_at)}</span>} />
          <Item label="Treatment" value={r.treatment_progress === null ? 'No plan' : `${r.treatment_progress}% complete`} />
        </dl>
        {Object.values(r.impact_dimensions ?? {}).some((v) => v > 0) && (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Impact by dimension</div>
            <div className="space-y-1.5">
              {Object.entries(r.impact_dimensions).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 text-xs">
                  <span className="w-28 text-muted">{humanize(k)}</span>
                  <div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-brand" style={{ width: `${v * 20}%` }} /></div>
                  <span className="w-4 tabular-nums text-fg">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {r.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{r.tags.map((t) => <Badge key={t}>#{t}</Badge>)}</div>}
      </div>

      <div className="space-y-5 lg:col-span-2">
        <div className="rounded-lg border border-border p-4">
          <div className="mb-3 flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wider text-muted">Score trail</span>
            <span className="flex gap-1.5"><ScoreChip l={r.inherent_likelihood} i={r.inherent_impact} label="Inherent" /><ScoreChip l={r.residual_likelihood} i={r.residual_impact} label="Residual" /><ScoreChip l={r.target_likelihood} i={r.target_impact} label="Target" /></span>
          </div>
          <ScoreTrail
            inherent={[r.inherent_likelihood, r.inherent_impact]}
            residual={[r.residual_likelihood, r.residual_impact]}
            target={r.target_likelihood && r.target_impact ? [r.target_likelihood, r.target_impact] : null}
          />
          <p className="mt-3 text-[11px] text-muted">
            Controls reduce this risk by <strong className="text-fg">{r.inherent_score - r.residual_score}</strong> points
            {r.target_score !== null && <>; the plan promises <strong className="text-fg">{r.residual_score - r.target_score}</strong> more</>}.
            Organization appetite ≤{r.settings.appetite_score}, tolerance ≤{r.settings.tolerance_score}.
          </p>
        </div>
        {r.fair_results && (
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Annualized loss exposure (FAIR)</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {(['p10', 'p50', 'p90'] as const).map((k) => (
                <div key={k} className={cn('rounded-md px-2 py-2', k === 'p50' ? 'bg-brand/10' : 'bg-surface-2/50')}>
                  <div className="text-base font-semibold tabular-nums text-fg">{money(r.fair_results![k])}</div>
                  <div className="text-[10px] uppercase text-muted">{k.toUpperCase()}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">Mean {money(r.fair_results.mean)} · {r.fair_results.iterations.toLocaleString()} simulations · P95 {money(r.fair_results.p95)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-fg">{value}</dd>
    </div>
  );
}

type ActProps = { r: RiskDetail; canManage: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean };

function TreatmentTab({ r, canManage, act, busy }: ActProps) {
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const now = Date.now();
  return (
    <div className="space-y-4">
      {r.treatment_progress !== null && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted"><span>Plan progress</span><span className="tabular-nums">{r.treatment_progress}%</span></div>
          <div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-success transition-all" style={{ width: `${r.treatment_progress}%` }} /></div>
        </div>
      )}
      {r.treatments.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No treatment plan yet. Add milestones to track mitigation like a POA&amp;M.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {r.treatments.map((t) => {
            const overdue = (t.status === 'planned' || t.status === 'in_progress') && t.due_at && new Date(t.due_at).getTime() < now;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm text-fg', t.status === 'done' && 'text-muted line-through', t.status === 'cancelled' && 'text-muted/60 line-through')}>{t.title}</div>
                  <div className="text-[11px] text-muted">
                    Due {fmtDate(t.due_at)}{t.owner?.name ? ` · ${t.owner.name}` : ''}{t.completed_at ? ` · done ${fmtDate(t.completed_at)}` : ''}
                  </div>
                </div>
                {overdue && <Badge tone="danger">Overdue</Badge>}
                {canManage ? (
                  <Select className="h-8 w-36 text-xs" value={t.status} disabled={busy} aria-label={`Status of ${t.title}`}
                    onChange={(e) => act(() => risksApi.updateTreatment(r.id, t.id, { status: e.target.value as typeof t.status }))}>
                    {['planned', 'in_progress', 'done', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </Select>
                ) : <Badge>{humanize(t.status)}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (title.trim().length < 2) return;
          act(() => risksApi.addTreatment(r.id, { title: title.trim(), dueAt: due ? new Date(due).toISOString() : null })).then(() => { setTitle(''); setDue(''); });
        }}>
          <Input className="h-9 min-w-[220px] flex-1" placeholder="New milestone, e.g. Enforce phishing-resistant MFA" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Milestone title" />
          <Input className="h-9 w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <Button size="sm" className="h-9" type="submit" disabled={busy || title.trim().length < 2}>Add milestone</Button>
        </form>
      )}
    </div>
  );
}

const LINK_HINT: Record<LinkKind, string> = {
  control: 'Control id, e.g. AC-2', finding: 'Posture finding id', ticket: 'Ticket id',
  problem: 'Problem id', change: 'Change id', service: 'Service id',
};
// Only kinds with a real per-record page get a link; the others have list pages that cannot
// deep-link to one record, and a link that lands on an unfiltered list is worse than none.
const LINK_HREF: Partial<Record<LinkKind, (ref: string) => string>> = {
  ticket: (ref) => `/tickets/${ref}`,
};

function LinksTab({ r, canManage, act, busy }: ActProps) {
  const [kind, setKind] = React.useState<LinkKind>('control');
  const [ref, setRef] = React.useState('');
  return (
    <div className="space-y-4">
      {r.links.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No evidence linked. Tie this risk to the controls that mitigate it and the findings and tickets behind it.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {r.links.map((l) => {
            const href = LINK_HREF[l.kind]?.(l.ref);
            return (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge tone={l.kind === 'control' ? 'accent' : l.kind === 'finding' ? 'warning' : 'neutral'} className="w-20 justify-center">{l.kind}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {href ? <a className="hover:underline" href={href}>{l.label ?? l.ref}</a> : (l.label ?? l.ref)}
                </span>
                {canManage && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => risksApi.removeLink(r.id, l.id))} aria-label={`Remove link ${l.label ?? l.ref}`}>Remove</Button>}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (ref.trim()) act(() => risksApi.addLink(r.id, kind, ref.trim())).then(() => setRef('')); }}>
          <Select className="h-9 w-36" value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} aria-label="Evidence type">
            {(Object.keys(LINK_HINT) as LinkKind[]).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
          </Select>
          <Input className="h-9 min-w-[220px] flex-1" placeholder={LINK_HINT[kind]} value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Reference" />
          <Button size="sm" className="h-9" type="submit" disabled={busy || !ref.trim()}>Link</Button>
        </form>
      )}
    </div>
  );
}

function AcceptanceTab({ r, canManage, canAccept, meId, act, busy }: ActProps & { canAccept: boolean; meId: string | undefined }) {
  const max = r.settings.max_acceptance_days;
  const defaultExpiry = new Date(Date.now() + Math.min(180, max) * 86_400_000).toISOString().slice(0, 10);
  const [why, setWhy] = React.useState('');
  const [expires, setExpires] = React.useState(defaultExpiry);
  const isRequester = r.acceptance_requested_by === meId;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Status:</span>
          <Badge tone={r.acceptance_active ? 'success' : r.acceptance_status === 'requested' ? 'warning' : r.acceptance_status === 'rejected' ? 'danger' : 'neutral'}>
            {r.acceptance_active ? 'Accepted' : r.acceptance_status === 'approved' ? 'Expired' : humanize(r.acceptance_status === 'none' ? 'not accepted' : r.acceptance_status)}
          </Badge>
          {r.acceptance_expires_at && <span className="text-xs text-muted">expires {fmtDate(r.acceptance_expires_at)}</span>}
        </div>
        {r.acceptance_justification && <p className="mt-3 whitespace-pre-wrap text-muted">“{r.acceptance_justification}”</p>}
        <p className="mt-2 text-[11px] text-muted">
          {r.acceptance_requested_by_user?.name && <>Requested by {r.acceptance_requested_by_user.name}. </>}
          {r.acceptance_decided_by_user?.name && <>Decided by {r.acceptance_decided_by_user.name}. </>}
          Acceptances are time-boxed (max {max} days here) and need a second person holding risk-acceptance authority.
          {r.appetite_state === 'above_tolerance' && <strong className="text-danger"> This risk is above tolerance — accepting it is an executive decision.</strong>}
        </p>
      </div>

      {r.acceptance_status === 'requested' && canAccept && (
        isRequester ? (
          <p className="text-xs text-muted">You requested this acceptance, so someone else must decide it (separation of duties).</p>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => act(() => risksApi.decideAcceptance(r.id, true))}>Approve acceptance</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => risksApi.decideAcceptance(r.id, false))}>Reject</Button>
          </div>
        )
      )}

      {canManage && r.acceptance_status !== 'requested' && r.status !== 'closed' && !r.acceptance_active && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act(() => risksApi.requestAcceptance(r.id, why.trim(), new Date(expires + 'T23:59:59Z').toISOString())).then(() => setWhy('')); }}>
          <Textarea value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Business justification and compensating controls (min. 10 characters)" aria-label="Acceptance justification" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted" htmlFor="risk-accept-expiry">Expires</label>
            <Input id="risk-accept-expiry" className="h-9 w-44" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <Button size="sm" className="h-9" type="submit" disabled={busy || why.trim().length < 10}>Request acceptance</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function HistoryTab({ r }: { r: RiskDetail }) {
  const series = r.history.map((h) => h.residual_score).filter((n): n is number => n !== null);
  return (
    <div className="space-y-4">
      {series.length > 1 && (
        <div className="rounded-lg border border-border p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Residual score over time</div>
          <Sparkline data={series} width={560} height={56} />
        </div>
      )}
      <ol className="relative space-y-4 border-l border-border pl-5">
        {[...r.history].reverse().map((h) => (
          <li key={h.id} className="relative">
            <span className="absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-brand" aria-hidden />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-fg">{humanize(h.kind)}</span>
              {h.residual_score !== null && <span className="text-xs tabular-nums text-muted">residual {h.residual_score}</span>}
              {h.status && <Badge className="text-[10px]">{humanize(h.status)}</Badge>}
            </div>
            <div className="text-[11px] text-muted">{new Date(h.created_at).toLocaleString()}{h.actor?.name ? ` · ${h.actor.name}` : ''}</div>
            {h.note && <p className="mt-1 text-xs text-muted">{h.note}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
