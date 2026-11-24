'use client';
// Risk report for one organization: score trend, rating mix over time, and today's inherent heat map.
// Every number comes from GET /risks/trend (rebuilt from risk_history) or the loaded register.
// Totals are sums of ordinal L×I scores and are labelled as an indicator, never as money.
import * as React from 'react';
import { Card, CardBody, CardHeader, CardTitle, SegmentedControl } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';
import { ApiError } from '@/lib/api';
import {
  heatmap, risksApi, RATINGS_ORDER, RATING_FILL, RATING_LABEL, type Risk, type RiskRating, type RiskSettings, type TrendPoint,
} from '@/lib/risks';
import { HeatMap } from './matrix';

const SERIES = [
  { key: 'inherent_total', label: 'Inherent', color: 'hsl(var(--brand))', dash: '' },
  { key: 'residual_total', label: 'Residual', color: 'hsl(var(--brand) / 0.6)', dash: '6 4' },
  { key: 'target_total', label: 'Target', color: 'hsl(var(--muted))', dash: '2 4' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

const fmtWeek = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function RiskReport({ organizationId, risks, settings }: { organizationId: string | undefined; risks: Risk[]; settings: RiskSettings | null }) {
  const [weeks, setWeeks] = React.useState<'12' | '26' | '52'>('12');
  const [points, setPoints] = React.useState<TrendPoint[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setPoints(null); setError(null);
    risksApi.trend(organizationId, Number(weeks))
      .then((p) => { if (live) setPoints(p); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : 'Could not load the risk trend.'); });
    return () => { live = false; };
  }, [organizationId, weeks]);

  const open = React.useMemo(() => risks.filter((r) => r.status !== 'closed'), [risks]);
  const grid = React.useMemo(() => heatmap(open, 'inherent'), [open]);
  const hasHistory = !!points?.some((p) => p.open > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Open risks, week by week, rebuilt from each risk&apos;s assessment history.</p>
        <SegmentedControl<'12' | '26' | '52'> size="sm" value={weeks} onChange={setWeeks}
          options={[{ value: '12', label: '12 weeks' }, { value: '26', label: '6 months' }, { value: '52', label: '1 year' }]} />
      </div>

      <Card>
        <CardHeader><CardTitle>Risk scores</CardTitle></CardHeader>
        <CardBody>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p>
            : !points ? <Skeleton className="h-56" />
              : !hasHistory ? <EmptyState title="Not enough history yet" description="The trend fills in as risks are recorded and reassessed." />
                : <ScoreLines points={points} />}
          <p className="mt-2 text-xs text-muted">Totals add up ordinal likelihood × impact scores across open risks. They show direction of travel, not financial exposure.</p>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Inherent risk over time</CardTitle></CardHeader>
          <CardBody>
            {error ? <p className="text-sm text-muted">Unavailable.</p>
              : !points ? <Skeleton className="h-56" />
                : !hasHistory ? <EmptyState title="Not enough history yet" description="Weekly rating mix appears once risks exist." />
                  : <RatingBars points={points} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Inherent risk as of today</CardTitle></CardHeader>
          <CardBody>
            {open.length ? <HeatMap grid={grid} appetite={settings?.appetite_score} tolerance={settings?.tolerance_score} />
              : <EmptyState title="No open risks" description="Nothing to place on the matrix." />}
          </CardBody>
        </Card>
      </div>

      {points && hasHistory && (
        <details className="rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">View as table</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="text-muted">
                <th className="py-1 pr-3">Week of</th><th className="pr-3">Open</th>
                {SERIES.map((s) => <th key={s.key} className="pr-3">{s.label} total</th>)}
                {RATINGS_ORDER.map((r) => <th key={r} className="pr-3">{RATING_LABEL[r]}</th>)}
              </tr></thead>
              <tbody>{points.map((p) => (
                <tr key={p.week} className="border-t border-border">
                  <td className="py-1 pr-3">{fmtWeek(p.week)}</td><td className="pr-3">{p.open}</td>
                  {SERIES.map((s) => <td key={s.key} className="pr-3">{p[s.key] ?? '—'}</td>)}
                  {RATINGS_ORDER.map((r) => <td key={r} className="pr-3">{p.by_inherent_rating[r]}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function ScoreLines({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const w = 760, h = 220, pad = { l: 36, r: 64, t: 12, b: 24 };
  const vals = (k: SeriesKey) => points.map((p) => p[k]);
  const max = Math.max(1, ...SERIES.flatMap((s) => vals(s.key).filter((v): v is number => v !== null)));
  const n = points.length;
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, n - 1);
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const path = (k: SeriesKey) => {
    let d = ''; let pen = false;
    points.forEach((p, i) => {
      const v = p[k];
      if (v === null) { pen = false; return; } // a gap, not a zero: a week with no target set is unknown
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true;
    });
    return d.trim();
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const every = Math.ceil(n / 6);
  const last = points[n - 1];
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - box.left) / box.width) * w;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((fx - pad.l) / (w - pad.l - pad.r)) * (n - 1)))));
  };
  return (
    <div className="relative w-full">
      <Legend items={SERIES.map((s) => ({ label: `${s.label} risk score`, color: s.color, dash: s.dash }))} />
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Inherent, residual and target risk score totals by week">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-muted" style={{ fontSize: 10 }}>{t}</text>
          </g>
        ))}
        {SERIES.map((s) => <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash || undefined} strokeLinejoin="round" strokeLinecap="round" />)}
        {/* Direct labels at the line ends (3 series, so every line gets one). */}
        {SERIES.map((s) => last[s.key] !== null && (
          <text key={s.key} x={x(n - 1) + 6} y={y(last[s.key] as number) + 3} className="fill-fg" style={{ fontSize: 10 }}>{s.label}</text>
        ))}
        {points.map((p, i) => i % every === 0 && (
          <text key={p.week} x={x(i)} y={h - 6} textAnchor="middle" className="fill-muted" style={{ fontSize: 10 }}>{fmtWeek(p.week)}</text>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke="hsl(var(--fg) / 0.35)" />
            {SERIES.map((s) => points[hover][s.key] !== null && (
              <circle key={s.key} cx={x(hover)} cy={y(points[hover][s.key] as number)} r={4} fill={s.color} stroke="hsl(var(--surface))" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={w - pad.l - pad.r} height={h - pad.t - pad.b} fill="transparent"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <Tooltip left={`${(x(hover) / w) * 100}%`}>
          <div className="font-medium">Week of {fmtWeek(points[hover].week)}</div>
          {SERIES.map((s) => <div key={s.key}>{s.label}: {points[hover][s.key] ?? 'not set'}</div>)}
          <div className="text-muted">{points[hover].open} open risks</div>
        </Tooltip>
      )}
    </div>
  );
}

function RatingBars({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = React.useState<{ i: number; r: RiskRating } | null>(null);
  const w = 520, h = 240, pad = { l: 30, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.open));
  const n = points.length;
  const slot = (w - pad.l - pad.r) / n;
  const bw = Math.max(6, Math.min(28, slot * 0.6));
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const every = Math.ceil(n / 6);
  const stack = [...RATINGS_ORDER].reverse(); // very_low at the baseline, very_high on top
  return (
    <div className="relative w-full">
      <Legend items={[...RATINGS_ORDER].reverse().map((r) => ({ label: RATING_LABEL[r], color: RATING_FILL[r] }))} />
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Open risks by inherent rating, by week">
        {[0, 0.5, 1].map((f) => { const t = Math.round(max * f); return (
          <g key={f}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-muted" style={{ fontSize: 10 }}>{t}</text>
          </g>
        ); })}
        {points.map((p, i) => {
          let acc = 0;
          const cx = pad.l + slot * i + (slot - bw) / 2;
          return (
            <g key={p.week}>
              {stack.map((r) => {
                const v = p.by_inherent_rating[r];
                if (!v) return null;
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                // 2px surface gap between stacked segments.
                return (
                  <rect key={r} x={cx} y={y1 + 1} width={bw} height={Math.max(1, y0 - y1 - 2)} rx={2} fill={RATING_FILL[r]}
                    stroke={hover?.i === i && hover.r === r ? 'hsl(var(--fg))' : 'none'}
                    onPointerEnter={() => setHover({ i, r })} onPointerLeave={() => setHover(null)} />
                );
              })}
              {i % every === 0 && <text x={cx + bw / 2} y={h - 6} textAnchor="middle" className="fill-muted" style={{ fontSize: 10 }}>{fmtWeek(p.week)}</text>}
            </g>
          );
        })}
      </svg>
      {hover && (
        <Tooltip left={`${((pad.l + slot * hover.i + slot / 2) / w) * 100}%`}>
          <div className="font-medium">Week of {fmtWeek(points[hover.i].week)}</div>
          <div>{RATING_LABEL[hover.r]}: {points[hover.i].by_inherent_rating[hover.r]} of {points[hover.i].open} open</div>
        </Tooltip>
      )}
    </div>
  );
}

function Legend({ items }: { items: Array<{ label: string; color: string; dash?: string }> }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden><line x1="1" x2="17" y1="4" y2="4" stroke={it.color} strokeWidth={it.dash === undefined ? 8 : 2} strokeDasharray={it.dash || undefined} strokeLinecap="round" /></svg>
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ left, children }: { left: string; children: React.ReactNode }) {
  return (
    <div role="status" className="pointer-events-none absolute top-6 z-10 -translate-x-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md" style={{ left }}>
      {children}
    </div>
  );
}
