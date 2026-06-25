'use client';
// Native helpdesk analytics — reproduces the IT Helpdesk Power BI dashboard
// (Overview + Agent Analysis) over our own ticket data.
import * as React from 'react';
import { analytics, type AnalyticsOverview, type ReportResult } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Badge, Button } from '@/components/ui/primitives';
import { StatCard, DataTable, Skeleton, EmptyState } from '@/components/ui/data';
import { Donut, Scatter, MiniBars } from '@/components/ui/charts';

const CAT_COLORS: Record<string, string> = {
  System: 'hsl(var(--brand))',
  'Login Access': 'hsl(var(--accent))',
  Software: 'hsl(var(--success))',
  Hardware: 'hsl(var(--warning))',
};
const PRIORITY_COLORS = ['hsl(var(--danger))', 'hsl(var(--warning))', 'hsl(var(--brand))', 'hsl(var(--muted))'];

export default function AnalyticsPage() {
  const [tab, setTab] = React.useState<'overview' | 'agents' | 'builder'>('overview');
  const [data, setData] = React.useState<AnalyticsOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    analytics.overview().then(setData).catch((e) => setError(e?.detail ?? 'Failed to load analytics'));
  }, []);

  if (error) return <Card><CardBody><p className="text-sm text-danger">{error}</p></CardBody></Card>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Helpdesk analytics</h1>
          <p className="mt-1 text-sm text-muted">Operational analysis across your in-scope ticket history.</p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-surface-2/60 p-1">
          {(['overview', 'agents', 'builder'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-4 py-1.5 text-xs font-medium capitalize transition ${
                tab === t ? 'bg-brand text-brand-fg' : 'text-muted hover:text-fg'
              }`}
            >
              {t === 'overview' ? 'Overview' : t === 'agents' ? 'Agent analysis' : 'Report builder'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'builder' ? (
        <ReportBuilder />
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : tab === 'overview' ? (
        <Overview data={data} />
      ) : (
        <Agents data={data} />
      )}
    </div>
  );
}

const DIM_LABEL: Record<string, string> = {
  status: 'Status', priority: 'Priority', type: 'Type', channel: 'Channel', category: 'Category',
  organization: 'Organization', month: 'Month', week: 'Week', day: 'Day',
};
const MEASURE_LABEL: Record<string, string> = {
  count: 'Ticket count', open: 'Open tickets', avg_resolution_days: 'Avg resolution (days)', avg_csat: 'Avg CSAT',
};

/** Self-service report builder: pick a dimension + measure + filters, render a bar table. */
function ReportBuilder() {
  const [fields, setFields] = React.useState<{ dimensions: string[]; measures: string[] } | null>(null);
  const [dimension, setDimension] = React.useState('priority');
  const [measure, setMeasure] = React.useState('count');
  const [days, setDays] = React.useState(90);
  const [status, setStatus] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => { analytics.reportFields().then(setFields).catch(() => {}); }, []);

  const run = React.useCallback(() => {
    setBusy(true); setError(null);
    analytics.report({ dimension, measure, days, status: status || undefined, priority: priority || undefined })
      .then(setResult)
      .catch((e) => setError(e?.detail ?? 'Report failed'))
      .finally(() => setBusy(false));
  }, [dimension, measure, days, status, priority]);
  React.useEffect(() => { run(); }, [run]);

  const max = Math.max(...(result?.rows.map((r) => r.value) ?? [1]), 1);
  const csv = () => {
    if (!result) return;
    const lines = [`${DIM_LABEL[result.dimension] ?? result.dimension},${MEASURE_LABEL[result.measure] ?? result.measure}`,
      ...result.rows.map((r) => `${JSON.stringify(r.label)},${r.value}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `report-${result.dimension}-${result.measure}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted">Group by</label>
            <select aria-label="Group by" className="block h-9 rounded-md border border-border bg-surface px-2 text-sm" value={dimension} onChange={(e) => setDimension(e.target.value)}>
              {(fields?.dimensions ?? []).map((d) => <option key={d} value={d}>{DIM_LABEL[d] ?? d}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted">Measure</label>
            <select aria-label="Measure" className="block h-9 rounded-md border border-border bg-surface px-2 text-sm" value={measure} onChange={(e) => setMeasure(e.target.value)}>
              {(fields?.measures ?? []).map((m) => <option key={m} value={m}>{MEASURE_LABEL[m] ?? m}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted">Window (days)</label>
            <select aria-label="Window in days" className="block h-9 rounded-md border border-border bg-surface px-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted">Status filter</label>
            <select aria-label="Status filter" className="block h-9 rounded-md border border-border bg-surface px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">any</option>
              {['new', 'triage', 'in_progress', 'pending', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted">Priority filter</label>
            <select aria-label="Priority filter" className="block h-9 rounded-md border border-border bg-surface px-2 text-sm" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">any</option>
              {['P1', 'P2', 'P3', 'P4'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <Button onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run'}</Button>
          <Button variant="outline" onClick={csv} disabled={!result || result.rows.length === 0}>Export CSV</Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{MEASURE_LABEL[measure] ?? measure} by {DIM_LABEL[dimension] ?? dimension}</CardTitle></CardHeader>
        <CardBody>
          {error ? <p className="text-sm text-danger">{error}</p>
            : !result ? <Skeleton className="h-40" />
            : result.rows.length === 0 ? <EmptyState title="No data" description="No tickets match these filters in the selected window." />
            : (
              <div className="space-y-1.5">
                {result.rows.map((r) => (
                  <div key={r.label} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate text-xs text-fg" title={r.label}>{r.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-surface-2">
                      <div className="flex h-full items-center rounded bg-brand px-2 text-[10px] font-medium text-brand-fg" style={{ width: `${Math.max((r.value / max) * 100, 2)}%` }}>
                      </div>
                    </div>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-fg">{r.value.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
        </CardBody>
      </Card>
    </div>
  );
}

function Overview({ data }: { data: AnalyticsOverview }) {
  const { kpis } = data;
  const maxYear = Math.max(...data.volumeByYear.map((v) => v.count), 1);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total tickets" value={kpis.totalTickets.toLocaleString()} tone="brand" delta={{ value: `${Math.abs(data.yoyTicketsPct)}% YoY`, positive: data.yoyTicketsPct >= 0 }} />
        <StatCard label="Avg resolution" value={`${kpis.avgResolutionDays}d`} tone="warning" />
        <StatCard label="Within SLA (≤3d)" value={`${kpis.withinSlaPct}%`} tone={kpis.withinSlaPct >= 60 ? 'success' : 'danger'} />
        <StatCard label="Avg rating" value={`${kpis.avgRating}/5`} tone="accent" />
        <StatCard label="Agents" value={kpis.totalAgents} tone="brand" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Volume by year */}
        <Card>
          <CardHeader><CardTitle>Ticket volume by year</CardTitle></CardHeader>
          <CardBody>
            <div className="flex h-48 items-end gap-4 px-2">
              {data.volumeByYear.map((v) => (
                <div key={v.year} className="flex flex-1 flex-col items-center gap-2">
                  <span className="text-xs tabular-nums text-fg">{(v.count / 1000 >= 1 ? `${(v.count / 1000).toFixed(0)}k` : v.count)}</span>
                  {/* height is a computed ratio */}
                  <div className="w-full rounded-t bg-gradient-to-t from-brand/40 to-brand" style={{ height: `${(v.count / maxYear) * 150}px` }} />
                  <span className="text-[11px] text-muted">{v.year}</span>
                </div>
              ))}
              {data.volumeByYear.length === 0 && <EmptyState title="No dated tickets" />}
            </div>
          </CardBody>
        </Card>

        {/* Priority & severity donuts */}
        <Card>
          <CardHeader><CardTitle>Volume by priority &amp; severity</CardTitle></CardHeader>
          <CardBody className="flex flex-wrap items-center justify-around gap-6">
            <Donut
              centerLabel="Priority"
              segments={data.byPriority.map((p, i) => ({ label: p.label, value: p.count, color: PRIORITY_COLORS[i % PRIORITY_COLORS.length] }))}
            />
            <Donut
              centerLabel="Severity"
              segments={data.bySeverity.map((s, i) => ({ label: s.label, value: s.count, color: i === 0 ? 'hsl(var(--danger))' : 'hsl(var(--brand))' }))}
            />
          </CardBody>
        </Card>
      </div>

      {/* Issue breakdown table */}
      <Card>
        <CardHeader><CardTitle>Issue breakdown</CardTitle></CardHeader>
        <CardBody className="px-0 pt-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-4 py-2">Issue type</th>
                <th className="px-4 py-2 text-right">% of class</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">Avg resolution</th>
                <th className="px-4 py-2 text-right">Within SLA</th>
              </tr>
            </thead>
            <tbody>
              {data.issueBreakdown.map((grp) => (
                <React.Fragment key={grp.klass}>
                  <tr className="border-b border-border/60 bg-surface-2/40">
                    <td className="px-4 py-2 font-semibold text-fg">{grp.klass}</td>
                    <td className="px-4 py-2 text-right text-muted">{grp.pctOfGrand}%</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-fg">{grp.total.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right" />
                    <td className="px-4 py-2 text-right" />
                  </tr>
                  {grp.categories.map((c) => (
                    <tr key={grp.klass + c.category} className="border-b border-border/40">
                      <td className="px-4 py-2 pl-8 text-muted">{c.category}</td>
                      <td className="px-4 py-2 text-right text-muted tabular-nums">{c.pctOfClass}%</td>
                      <td className="px-4 py-2 text-right tabular-nums text-fg">{c.total.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">{c.avgResolutionDays}d</td>
                      <td className="px-4 py-2 text-right">
                        <Badge tone={c.withinSlaPct >= 60 ? 'success' : c.withinSlaPct >= 30 ? 'warning' : 'danger'}>{c.withinSlaPct}%</Badge>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Category SLA compliance */}
      <Card>
        <CardHeader><CardTitle>Resolution &amp; SLA compliance by category</CardTitle></CardHeader>
        <CardBody className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-medium text-muted">Ticket volume by category</div>
            <MiniBars items={data.byCategory.map((c) => ({ label: c.category, value: c.total, color: CAT_COLORS[c.category] ?? 'hsl(var(--brand))' }))} />
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-muted">SLA compliance (≤3 days)</div>
            <MiniBars items={data.byCategory.map((c) => ({ label: c.category, value: c.withinSlaPct, color: c.withinSlaPct >= 60 ? 'hsl(var(--success))' : 'hsl(var(--danger))' }))} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Agents({ data }: { data: AnalyticsOverview }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Agent performance breakdown</CardTitle></CardHeader>
        <CardBody className="px-0 pt-0">
          <DataTable
            rows={data.agents.map((a) => ({ ...a, id: a.agentId }))}
            empty={<EmptyState title="No agent data" description="Assign tickets to agents to populate this view." />}
            columns={[
              { key: 'name', header: 'Agent', render: (a) => <span className="font-medium text-fg">{a.name}</span> },
              { key: 'tickets', header: 'Tickets', render: (a) => <span className="tabular-nums text-fg">{a.tickets.toLocaleString()}</span> },
              { key: 'res', header: 'Avg resolution', render: (a) => <span className="tabular-nums text-muted">{a.avgResolutionDays}d</span> },
              { key: 'sla', header: 'Within SLA', render: (a) => <Badge tone={a.withinSlaPct >= 60 ? 'success' : a.withinSlaPct >= 30 ? 'warning' : 'danger'}>{a.withinSlaPct}%</Badge> },
              { key: 'rating', header: 'Rating', render: (a) => <span className="tabular-nums text-fg">{a.avgRating || '—'}</span> },
            ]}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Leaderboard title="Top rated agents" items={data.topRated.map((a) => ({ label: a.name, value: a.avgRating, color: 'hsl(var(--success))' }))} />
        <Leaderboard title="Worst rated agents" items={data.worstRated.map((a) => ({ label: a.name, value: a.avgRating, color: 'hsl(var(--danger))' }))} />
        <Leaderboard title="Top 5 by tickets" items={data.topByTickets.map((a) => ({ label: a.name, value: a.tickets, color: 'hsl(var(--brand))' }))} />
        <Leaderboard title="Bottom 5 by tickets" items={data.bottomByTickets.map((a) => ({ label: a.name, value: a.tickets, color: 'hsl(var(--muted))' }))} />
      </div>

      <Card>
        <CardHeader><CardTitle>Does resolution time influence rating?</CardTitle></CardHeader>
        <CardBody>
          <Scatter
            points={data.scatter.map((s) => ({ x: s.resolutionDays, y: s.avgRating, size: s.tickets }))}
            width={520}
            height={220}
            xLabel="Resolution time (days)"
            yLabel="Avg rating"
          />
          <p className="mt-2 text-xs text-muted">Bubble size = ticket count. Longer resolution times trend toward lower satisfaction.</p>
        </CardBody>
      </Card>
    </div>
  );
}

function Leaderboard({ title, items }: { title: string; items: Array<{ label: string; value: number; color?: string }> }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardBody>
        {items.length ? <MiniBars items={items} /> : <p className="text-xs text-muted">No data.</p>}
      </CardBody>
    </Card>
  );
}
