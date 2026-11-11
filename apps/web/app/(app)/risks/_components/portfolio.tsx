'use client';
// Cross-organization portfolio. Each organization is a separate card judged against ITS OWN
// appetite — never pooled into one heat map, where a calm large customer would dilute a small one
// that is over tolerance. Ordered worst-first by the API (rankPortfolio).
import * as React from 'react';
import { Card, Badge } from '@/components/ui/primitives';
import { EmptyState, StatCard } from '@/components/ui/data';
import { cn } from '@/lib/cn';
import { RATING_FILL, RATING_LABEL, money, ratingFor, type PortfolioRow, type RiskRating } from '@/lib/risks';
import { RatingBadge } from './matrix';

const ORDER: RiskRating[] = ['very_high', 'high', 'moderate', 'low', 'very_low'];

function RatingBar({ by }: { by: Record<RiskRating, number> }) {
  const total = ORDER.reduce((a, r) => a + by[r], 0);
  if (total === 0) return <div className="h-2 rounded-full bg-surface-2" aria-label="No open risks" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" role="img"
      aria-label={ORDER.filter((r) => by[r]).map((r) => `${by[r]} ${RATING_LABEL[r]}`).join(', ')}>
      {ORDER.map((r) => by[r] ? <div key={r} style={{ width: `${(by[r] / total) * 100}%`, background: RATING_FILL[r] }} /> : null)}
    </div>
  );
}

export function Portfolio({ rows, onOpen }: { rows: PortfolioRow[]; onOpen: (orgId: string) => void }) {
  if (rows.length === 0) {
    return <Card className="p-6"><EmptyState title="No organizations in scope" description="You are not assigned to any organization's risk register." /></Card>;
  }
  const totals = rows.reduce(
    (a, r) => ({
      open: a.open + r.open,
      overTol: a.overTol + (r.above_tolerance > 0 ? 1 : 0),
      overdue: a.overdue + r.overdue_reviews,
      ale: r.ale_p50 === null ? a.ale : (a.ale ?? 0) + r.ale_p50,
    }),
    { open: 0, overTol: 0, overdue: 0, ale: null as number | null },
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Organizations" value={rows.length} />
        <StatCard label="Open risks" value={totals.open} />
        <StatCard label="Orgs over tolerance" value={totals.overTol} tone="danger" />
        <StatCard label="Quantified exposure (P50)" value={money(totals.ale)} tone="warning" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => {
          const worst = r.worst_residual ? ratingFor(r.worst_residual) : null;
          return (
            <Card key={r.organization_id} className={cn('flex flex-col p-0 transition hover:border-brand/50', r.above_tolerance > 0 && 'border-danger/40')}>
              <button type="button" onClick={() => onOpen(r.organization_id)}
                className="flex flex-1 flex-col gap-4 rounded-lg p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                aria-label={`Open ${r.organization_name} risk register`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-fg">{r.organization_name}</div>
                    <div className="mt-0.5 text-[11px] text-muted">Appetite ≤{r.appetite_score} · tolerance ≤{r.tolerance_score}</div>
                  </div>
                  {worst ? <RatingBadge rating={worst} score={r.worst_residual!} /> : <Badge>No open risks</Badge>}
                </div>
                <RatingBar by={r.by_rating} />
                <dl className="grid grid-cols-4 gap-2 text-center">
                  <Metric label="Open" value={r.open} />
                  <Metric label="> appetite" value={r.above_appetite} tone={r.above_appetite ? 'warning' : undefined} />
                  <Metric label="> tolerance" value={r.above_tolerance} tone={r.above_tolerance ? 'danger' : undefined} />
                  <Metric label="Overdue" value={r.overdue_reviews} tone={r.overdue_reviews ? 'warning' : undefined} />
                </dl>
                <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                  <span className="text-muted">ALE P50 / P90</span>
                  <span className="tabular-nums text-fg">
                    {r.ale_p50 === null ? <span className="text-muted">not quantified</span> : <>{money(r.ale_p50)} <span className="text-muted">/</span> {money(r.ale_p90)}</>}
                  </span>
                </div>
              </button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'danger' }) {
  return (
    // dt before dd for assistive tech; flex-col-reverse puts the number on top visually.
    <div className="flex flex-col-reverse rounded-md bg-surface-2/50 px-1 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={cn('text-lg font-semibold tabular-nums', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg')}>{value}</dd>
    </div>
  );
}
