'use client';
// Risk register. One register per organization:
//   * staff (nexus plane) land on the PORTFOLIO — every organization they look after as its own
//     card, worst first — and open one organization's register from there;
//   * customers see only their own organization's register, with no switcher at all.
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, SegmentedControl, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { MiniBars } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import {
  CATEGORIES, IMPACT_LABELS, LIKELIHOOD_LABELS, RATING_LABEL, STATUSES, heatmap, humanize, money, risksApi,
  type HeatmapBasis, type PortfolioRow, type Risk, type RiskRating, type RiskSettings,
} from '@/lib/risks';
import { HeatMap, RatingBadge, ScoreChip } from './_components/matrix';
import { Portfolio } from './_components/portfolio';
import { RiskForm } from './_components/risk-form';
import { RiskDetailDialog, AppetiteBadge } from './_components/risk-detail';
import { AppetiteDialog, FindingImportDialog } from './_components/governance';

type Sort = 'residual' | 'inherent' | 'review' | 'ref' | 'ale';
type Flag = 'above_appetite' | 'overdue' | 'pending';

const ALL = '';

export default function RisksPage() {
  const { me, can } = useAuth();
  const isAgent = me?.plane === 'nexus';
  const canManage = can('risk.manage');
  const canAccept = can('risk.accept');

  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const [orgId, setOrgId] = React.useState<string>(ALL);
  const [portfolio, setPortfolio] = React.useState<PortfolioRow[] | null>(null);
  const [risks, setRisks] = React.useState<Risk[] | null>(null);
  const [settings, setSettings] = React.useState<RiskSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [q, setQ] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [rating, setRating] = React.useState('');
  const [flags, setFlags] = React.useState<Set<Flag>>(new Set());
  const [cell, setCell] = React.useState<{ l: number; i: number } | null>(null);
  const [basis, setBasis] = React.useState<HeatmapBasis>('residual');
  const [sort, setSort] = React.useState<Sort>('residual');

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Risk | null | 'new'>(null);
  const [showAppetite, setShowAppetite] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const showPortfolio = isAgent && orgId === ALL;
  // Customers act on their own organization; the API ignores/refuses anything else.
  const org = isAgent ? orgId || undefined : undefined;

  React.useEffect(() => {
    if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => setOrgs([]));
  }, [isAgent]);

  const loadPortfolio = React.useCallback(() => {
    if (!isAgent) return;
    risksApi.portfolio().then(setPortfolio).catch((e) => { setPortfolio([]); setLoadError(e instanceof ApiError ? e.detail : 'Could not load the portfolio'); });
  }, [isAgent]);

  const loadRegister = React.useCallback(() => {
    if (!me || showPortfolio) return;
    setLoadError(null);
    risksApi.list(org, { includeClosed: status === 'closed' || undefined, status: status || undefined, category: category || undefined })
      .then(setRisks)
      .catch((e) => { setRisks([]); setLoadError(e instanceof ApiError ? e.detail : 'Could not load the register'); });
    risksApi.settings(org).then(setSettings).catch(() => setSettings(null));
  }, [me, showPortfolio, org, status, category]);

  React.useEffect(() => { if (showPortfolio) loadPortfolio(); }, [showPortfolio, loadPortfolio]);
  React.useEffect(() => { setRisks(null); loadRegister(); }, [loadRegister]);
  React.useEffect(() => { setCell(null); setFlags(new Set()); }, [orgId]);

  const refresh = React.useCallback(() => { loadRegister(); loadPortfolio(); }, [loadRegister, loadPortfolio]);

  // ---- client-side refinement (search, rating, flags, heat-map cell) ----
  const visible = React.useMemo(() => {
    if (!risks) return null;
    const needle = q.trim().toLowerCase();
    const rows = risks.filter((r) => {
      if (needle && !(`${r.ref} ${r.title} ${r.description ?? ''} ${r.tags.join(' ')}`.toLowerCase().includes(needle))) return false;
      if (rating && r.residual_rating !== rating) return false;
      if (flags.has('above_appetite') && r.appetite_state === 'within') return false;
      if (flags.has('overdue') && !r.review_overdue) return false;
      if (flags.has('pending') && r.acceptance_status !== 'requested') return false;
      if (cell) {
        const l = basis === 'inherent' ? r.inherent_likelihood : basis === 'residual' ? r.residual_likelihood : r.target_likelihood;
        const i = basis === 'inherent' ? r.inherent_impact : basis === 'residual' ? r.residual_impact : r.target_impact;
        if (l !== cell.l || i !== cell.i) return false;
      }
      return true;
    });
    const by: Record<Sort, (a: Risk, b: Risk) => number> = {
      residual: (a, b) => b.residual_score - a.residual_score || b.inherent_score - a.inherent_score,
      inherent: (a, b) => b.inherent_score - a.inherent_score,
      review: (a, b) => new Date(a.next_review_at).getTime() - new Date(b.next_review_at).getTime(),
      ref: (a, b) => a.risk_number - b.risk_number,
      ale: (a, b) => (b.fair_results?.p50 ?? -1) - (a.fair_results?.p50 ?? -1),
    };
    return [...rows].sort(by[sort]);
  }, [risks, q, rating, flags, cell, basis, sort]);

  const open = React.useMemo(() => (risks ?? []).filter((r) => r.status !== 'closed'), [risks]);
  const grid = React.useMemo(() => heatmap(open, basis), [open, basis]);
  const kpi = {
    open: open.length,
    above: open.filter((r) => r.appetite_state !== 'within').length,
    overTol: open.filter((r) => r.appetite_state === 'above_tolerance').length,
    overdue: open.filter((r) => r.review_overdue).length,
    pending: open.filter((r) => r.acceptance_status === 'requested').length,
    ale: open.some((r) => r.fair_results) ? open.reduce((a, r) => a + (r.fair_results?.p50 ?? 0), 0) : null,
  };
  const byCategory = CATEGORIES.map((c) => ({ label: humanize(c), value: open.filter((r) => r.category === c).length })).filter((x) => x.value > 0);

  const orgName = orgs.find((o) => o.id === orgId)?.name;
  const toggleFlag = (f: Flag) => setFlags((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  async function exportCsv() {
    setExporting(true);
    try { await risksApi.exportCsv(org); } catch { setLoadError('Export failed'); } finally { setExporting(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {isAgent && !showPortfolio && (
              <button type="button" className="hover:text-fg hover:underline" onClick={() => setOrgId(ALL)}>All organizations</button>
            )}
            {isAgent && !showPortfolio && <span aria-hidden>/</span>}
            {!showPortfolio && orgName && <span>{orgName}</span>}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Risk register</h1>
          <p className="mt-1 text-sm text-muted">
            {showPortfolio
              ? 'Each organization’s register, judged against its own appetite. Worst first.'
              : 'Identify, assess, treat and accept risk — inherent, residual and target, with FAIR exposure.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAgent && (
            <Select className="h-9 w-60" value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
              <option value={ALL}>All organizations (portfolio)</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          )}
          {!showPortfolio && (
            <>
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</Button>
              {canAccept && settings && <Button size="sm" variant="outline" onClick={() => setShowAppetite(true)}>Appetite</Button>}
              {canManage && <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>From findings</Button>}
              {canManage && <Button size="sm" onClick={() => setEditing('new')}>New risk</Button>}
            </>
          )}
        </div>
      </div>

      {loadError && <p className="text-sm text-danger" role="alert">{loadError}</p>}

      {showPortfolio ? (
        portfolio ? <Portfolio rows={portfolio} onOpen={setOrgId} /> : <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Open risks" value={risks ? kpi.open : '—'} />
            <StatCard label="Above appetite" value={risks ? <>{kpi.above}{kpi.overTol > 0 && <span className="ml-2 text-sm font-medium text-danger">{kpi.overTol} over tolerance</span>}</> : '—'} tone="warning" />
            <StatCard label="Reviews overdue" value={risks ? kpi.overdue : '—'} tone="danger" />
            <StatCard label="Exposure (ALE P50)" value={risks ? money(kpi.ale) : '—'} tone="accent" />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <div className="flex flex-wrap items-center justify-between gap-2 p-5 pb-3">
                <div>
                  <CardTitle>Heat map</CardTitle>
                  <p className="mt-0.5 text-[11px] text-muted">
                    Click a cell to filter. Dashed cells are above this organization’s appetite (≤{settings?.appetite_score ?? '—'}) or tolerance (≤{settings?.tolerance_score ?? '—'}).
                  </p>
                </div>
                <SegmentedControl<HeatmapBasis> size="sm" value={basis} onChange={(b) => { setBasis(b); setCell(null); }} options={[
                  { value: 'inherent', label: 'Inherent' }, { value: 'residual', label: 'Residual' }, { value: 'target', label: 'Target' },
                ]} />
              </div>
              <CardBody>
                {!risks ? <Skeleton className="h-64" /> : (
                  <HeatMap grid={grid} selected={cell} onSelect={setCell} appetite={settings?.appetite_score} tolerance={settings?.tolerance_score} />
                )}
              </CardBody>
            </Card>
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader><CardTitle>By residual rating</CardTitle></CardHeader>
                <CardBody className="space-y-2">
                  {(['very_high', 'high', 'moderate', 'low', 'very_low'] as RiskRating[]).map((r) => {
                    const n = open.filter((x) => x.residual_rating === r).length;
                    const active = rating === r;
                    return (
                      <button key={r} type="button" onClick={() => setRating(active ? '' : r)} aria-pressed={active}
                        className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-2', active && 'bg-surface-2 ring-1 ring-border')}>
                        <RatingBadge rating={r} />
                        <span className="tabular-nums text-fg">{n}</span>
                      </button>
                    );
                  })}
                </CardBody>
              </Card>
              <Card>
                <CardHeader><CardTitle>By category</CardTitle></CardHeader>
                <CardBody>{byCategory.length ? <MiniBars items={byCategory} /> : <p className="text-xs text-muted">No open risks.</p>}</CardBody>
              </Card>
            </div>
          </div>

          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
              <Input className="h-9 w-64" placeholder="Search ref, title, tags…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search risks" />
              <Select className="h-9 w-40" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                <option value="">All categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </Select>
              <Select className="h-9 w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="">Open (any)</option>
                {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
              <Select className="h-9 w-40" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
                <option value="residual">Sort: residual ↓</option>
                <option value="inherent">Sort: inherent ↓</option>
                <option value="ale">Sort: exposure ↓</option>
                <option value="review">Sort: next review</option>
                <option value="ref">Sort: reference</option>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                <FlagChip on={flags.has('above_appetite')} onClick={() => toggleFlag('above_appetite')}>Above appetite · {kpi.above}</FlagChip>
                <FlagChip on={flags.has('overdue')} onClick={() => toggleFlag('overdue')}>Review overdue · {kpi.overdue}</FlagChip>
                <FlagChip on={flags.has('pending')} onClick={() => toggleFlag('pending')}>Acceptance pending · {kpi.pending}</FlagChip>
              </div>
              {(cell || rating) && (
                <button type="button" className="ml-auto text-xs text-brand hover:underline" onClick={() => { setCell(null); setRating(''); }}>
                  {cell ? `${LIKELIHOOD_LABELS[cell.l - 1]} × ${IMPACT_LABELS[cell.i - 1]}` : RATING_LABEL[rating as RiskRating]} ✕ clear
                </button>
              )}
            </div>
            <CardBody className="px-0 pt-0">
              {!visible ? (
                <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : (
                <DataTable<Risk>
                  rows={visible}
                  onRowClick={(r) => setOpenId(r.id)}
                  empty={
                    <EmptyState
                      title={risks && risks.length ? 'No risks match these filters' : 'The register is empty'}
                      description={risks && risks.length ? 'Clear a filter or pick another heat-map cell.' : 'Add the first risk, or raise risks from open posture findings.'}
                      action={canManage && !(risks && risks.length) ? <Button size="sm" onClick={() => setEditing('new')}>New risk</Button> : undefined}
                    />
                  }
                  columns={[
                    { key: 'ref', header: 'Ref', render: (r) => <span className="font-mono text-xs text-muted">{r.ref}</span> },
                    {
                      key: 'title', header: 'Risk', render: (r) => (
                        <div className="min-w-[220px]">
                          <div className="font-medium text-fg">{r.title}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                            {humanize(r.category)}
                            {r.owner?.name || r.owner_name ? <> · {r.owner?.name ?? r.owner_name}</> : null}
                            {r.review_overdue && <Badge tone="warning" className="px-1.5 py-0 text-[10px]">review overdue</Badge>}
                            {r.acceptance_status === 'requested' && <Badge tone="warning" className="px-1.5 py-0 text-[10px]">acceptance pending</Badge>}
                          </div>
                        </div>
                      ),
                    },
                    { key: 'inh', header: 'Inherent', render: (r) => <ScoreChip l={r.inherent_likelihood} i={r.inherent_impact} label="Inherent" /> },
                    { key: 'res', header: 'Residual', render: (r) => <ScoreChip l={r.residual_likelihood} i={r.residual_impact} label="Residual" /> },
                    { key: 'tgt', header: 'Target', render: (r) => <ScoreChip l={r.target_likelihood} i={r.target_impact} label="Target" /> },
                    { key: 'app', header: 'Appetite', render: (r) => <AppetiteBadge state={r.appetite_state} /> },
                    { key: 'ale', header: 'ALE P50', className: 'text-right', render: (r) => <span className="tabular-nums text-xs text-fg">{money(r.fair_results?.p50)}</span> },
                    {
                      key: 'plan', header: 'Treatment', render: (r) => r.treatment_progress === null ? <span className="text-xs text-muted">—</span> : (
                        <div className="w-24">
                          <div className="h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full bg-success" style={{ width: `${r.treatment_progress}%` }} /></div>
                          <div className="mt-0.5 text-[10px] tabular-nums text-muted">{r.treatment_progress}%{r.treatments_overdue ? <span className="text-danger"> · {r.treatments_overdue} late</span> : null}</div>
                        </div>
                      ),
                    },
                    { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'accepted' ? (r.acceptance_active ? 'accent' : 'warning') : r.status === 'closed' ? 'neutral' : 'brand'}>{humanize(r.status)}{r.status === 'accepted' && !r.acceptance_active ? ' (expired)' : ''}</Badge> },
                  ]}
                />
              )}
            </CardBody>
          </Card>
        </>
      )}

      {openId && (
        <RiskDetailDialog
          riskId={openId}
          onClose={() => setOpenId(null)}
          onEdit={(r) => { setOpenId(null); setEditing(r); }}
          onChanged={refresh}
          canManage={canManage}
          canAccept={canAccept}
          meId={me?.id}
        />
      )}
      {editing && (
        <RiskForm
          organizationId={org}
          risk={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(r) => { setEditing(null); refresh(); setOpenId(r.id); }}
        />
      )}
      {showAppetite && settings && (
        <AppetiteDialog organizationId={org} settings={settings} onClose={() => setShowAppetite(false)} onSaved={() => { setShowAppetite(false); refresh(); }} />
      )}
      {showImport && <FindingImportDialog organizationId={org} onClose={() => { setShowImport(false); }} onImported={refresh} />}
    </div>
  );
}

function FlagChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn('h-7 rounded-full border px-3 text-xs transition', on ? 'border-brand/50 bg-brand/15 text-brand' : 'border-border text-muted hover:text-fg')}>
      {children}
    </button>
  );
}
