'use client';
import React from 'react';
import Link from 'next/link';
import { api, analytics, dashboardsApi, type Dashboard, type AnalyticsOverview, type OperationalKpis } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field } from '@/components/ui/primitives';
import { StatCard, EmptyState, Skeleton } from '@/components/ui/data';
import { Donut, MiniBars, TrendChart } from '@/components/ui/charts';
import { DashboardWidget } from '@/components/ui/dashboard-widgets';

type Tab = 'executive' | 'sla' | 'operations' | 'custom';
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'executive', label: 'Executive KPIs', hint: 'Backlog, throughput, MTTR, CSAT' },
  { id: 'sla', label: 'SLA performance', hint: 'Response & resolution attainment' },
  { id: 'operations', label: 'Ticket operations', hint: 'Opened vs closed, backlog' },
  { id: 'custom', label: 'Custom', hint: 'Your saved dashboards' },
];
const PERIODS = [7, 30, 90];
const PRIORITY_COLOR: Record<string, string> = {
  P1: 'hsl(var(--danger))', P2: 'hsl(var(--warning))', P3: 'hsl(var(--brand))', P4: 'hsl(var(--muted))',
};

export default function DashboardsPage() {
  const { can, me } = useAuth();
  const isAgent = me?.plane === 'nexus';
  const [tab, setTab] = React.useState<Tab>('executive');
  const [days, setDays] = React.useState(30);
  const [orgId, setOrgId] = React.useState('');
  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const [kpis, setKpis] = React.useState<OperationalKpis | null>(null);
  const [overview, setOverview] = React.useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {});
  }, [isAgent]);

  React.useEffect(() => {
    if (tab === 'custom') return;
    setLoading(true);
    Promise.all([
      analytics.kpis(days, orgId || undefined).catch(() => null),
      analytics.overview().catch(() => null),
    ]).then(([k, o]) => { setKpis(k); setOverview(o); }).finally(() => setLoading(false));
  }, [days, orgId, tab]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1>
          <p className="mt-1 text-sm text-muted">
            Operational analytics across tickets, SLAs, and team throughput.{' '}
            <Link className="text-brand hover:underline" href="/analytics">Deep-dive analytics →</Link>
          </p>
        </div>
        {tab !== 'custom' && (
          <div className="flex items-center gap-2">
            {isAgent && (
              <select
                title="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
              >
                <option value="">All customers</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
            <div className="flex overflow-hidden rounded-md border border-border">
              {PERIODS.map((p) => (
                <button
                  key={p} onClick={() => setDays(p)}
                  className={`px-3 py-1.5 text-sm ${days === p ? 'bg-brand text-brand-fg' : 'bg-surface text-muted hover:text-fg'}`}
                >{p}d</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id} onClick={() => setTab(t.id)} title={t.hint}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'custom' ? (
        <CustomDashboards isAgent={isAgent} orgs={orgs} canManage={can('dashboard.manage')} />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : !kpis ? (
        <EmptyState title="No analytics available" description="You may not have reporting permission for this view." />
      ) : tab === 'executive' ? (
        <Executive kpis={kpis} />
      ) : tab === 'sla' ? (
        <SlaPerformance kpis={kpis} overview={overview} />
      ) : (
        <Operations kpis={kpis} />
      )}
    </div>
  );
}

function fmtDays(n: number) { return n >= 1 ? `${n.toFixed(1)}d` : `${Math.round(n * 24)}h`; }

function Executive({ kpis }: { kpis: OperationalKpis }) {
  const s = kpis.summary;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open tickets" value={s.open} tone="brand" delta={s.open_p1 ? { value: `${s.open_p1} P1 open`, positive: false } : undefined} />
        <StatCard label="Opened today" value={s.opened_today} tone="accent" />
        <StatCard label="Closed today" value={s.closed_today} tone="success" />
        <StatCard label="SLA attainment" value={`${kpis.sla.overallAttainmentPct}%`} tone={kpis.sla.overallAttainmentPct >= 90 ? 'success' : kpis.sla.overallAttainmentPct >= 75 ? 'warning' : 'danger'} />
        <StatCard label="Mean time to resolve" value={fmtDays(s.mttr_days)} tone="brand" />
        <StatCard label="CSAT (avg)" value={s.csat ? `${s.csat.toFixed(2)} / 5` : '—'} tone="warning" />
        <StatCard label="Opened this week" value={s.opened_week} tone="accent" />
        <StatCard label="Closed this week" value={s.closed_week} tone="success" />
      </div>
      <Card>
        <CardHeader><CardTitle>Tickets opened vs closed · last {kpis.days} days</CardTitle></CardHeader>
        <CardBody><TrendChart data={kpis.trend} /></CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Open backlog by priority</CardTitle></CardHeader>
          <CardBody>{kpis.byPriority.length ? <MiniBars items={kpis.byPriority.map((b) => ({ label: b.label, value: b.count, color: PRIORITY_COLOR[b.label] }))} /> : <EmptyState title="No open tickets" />}</CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Open backlog by status</CardTitle></CardHeader>
          <CardBody>{kpis.byStatus.length ? <MiniBars items={kpis.byStatus.map((b) => ({ label: b.label.replace(/_/g, ' '), value: b.count }))} /> : <EmptyState title="No open tickets" />}</CardBody>
        </Card>
      </div>
    </div>
  );
}

function SlaPerformance({ kpis, overview }: { kpis: OperationalKpis; overview: AnalyticsOverview | null }) {
  const sla = kpis.sla;
  const tone = (p: number): 'success' | 'warning' | 'danger' => (p >= 90 ? 'success' : p >= 75 ? 'warning' : 'danger');
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Overall attainment" value={`${sla.overallAttainmentPct}%`} tone={tone(sla.overallAttainmentPct)} />
        <StatCard label="Response attainment" value={`${sla.responseAttainmentPct}%`} tone={tone(sla.responseAttainmentPct)} delta={{ value: `${sla.responseBreached} breached`, positive: sla.responseBreached === 0 }} />
        <StatCard label="Resolution attainment" value={`${sla.resolutionAttainmentPct}%`} tone={tone(sla.resolutionAttainmentPct)} delta={{ value: `${sla.resolutionBreached} breached`, positive: sla.resolutionBreached === 0 }} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>SLA outcomes (met vs breached)</CardTitle></CardHeader>
          <CardBody>
            <Donut
              size={190}
              centerLabel="attainment"
              centerValue={`${sla.overallAttainmentPct}%`}
              segments={[
                { label: 'Met', value: sla.responseMet + sla.resolutionMet, color: 'hsl(var(--success))' },
                { label: 'Breached', value: sla.responseBreached + sla.resolutionBreached, color: 'hsl(var(--danger))' },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Within-SLA by category</CardTitle></CardHeader>
          <CardBody>
            {overview?.byCategory?.length ? (
              <MiniBars
                items={overview.byCategory.slice(0, 8).map((c) => ({
                  label: c.category, value: Math.round(c.withinSlaPct),
                  color: c.withinSlaPct >= 90 ? 'hsl(var(--success))' : c.withinSlaPct >= 75 ? 'hsl(var(--warning))' : 'hsl(var(--danger))',
                }))}
              />
            ) : <EmptyState title="No category data" />}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Throughput · last {kpis.days} days</CardTitle></CardHeader>
        <CardBody><TrendChart data={kpis.trend} /></CardBody>
      </Card>
    </div>
  );
}

function Operations({ kpis }: { kpis: OperationalKpis }) {
  const s = kpis.summary;
  const net = s.opened_week - s.closed_week;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open backlog" value={s.open} tone="brand" />
        <StatCard label="Opened (this week)" value={s.opened_week} tone="accent" />
        <StatCard label="Closed (this week)" value={s.closed_week} tone="success" />
        <StatCard label="Net backlog change" value={`${net >= 0 ? '+' : ''}${net}`} tone={net > 0 ? 'warning' : 'success'} />
      </div>
      <Card>
        <CardHeader><CardTitle>Tickets opened vs closed · last {kpis.days} days</CardTitle></CardHeader>
        <CardBody><TrendChart data={kpis.trend} height={220} /></CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Backlog by status</CardTitle></CardHeader>
          <CardBody>{kpis.byStatus.length ? <MiniBars items={kpis.byStatus.map((b) => ({ label: b.label.replace(/_/g, ' '), value: b.count }))} /> : <EmptyState title="None open" />}</CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Backlog by priority</CardTitle></CardHeader>
          <CardBody>{kpis.byPriority.length ? <MiniBars items={kpis.byPriority.map((b) => ({ label: b.label, value: b.count, color: PRIORITY_COLOR[b.label] }))} /> : <EmptyState title="None open" />}</CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Backlog by age</CardTitle></CardHeader>
          <CardBody>{kpis.byAge.length ? <MiniBars items={kpis.byAge.map((b) => ({ label: b.label, value: b.count, color: b.label === '> 7 days' ? 'hsl(var(--danger))' : b.label === '3-7 days' ? 'hsl(var(--warning))' : 'hsl(var(--brand))' }))} /> : <EmptyState title="None open" />}</CardBody>
        </Card>
      </div>
    </div>
  );
}

// ---- Custom (saved) dashboards: the original named-dashboard builder ----
function CustomDashboards({ isAgent, orgs, canManage }: { isAgent: boolean; orgs: { id: string; name: string }[]; canManage: boolean }) {
  const [list, setList] = React.useState<Dashboard[] | null>(null);
  const [active, setActive] = React.useState<Dashboard | null>(null);
  const [overview, setOverview] = React.useState<AnalyticsOverview | null>(null);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { dashboardsApi.list().then((d) => { setList(d); setActive(d.find((x) => x.is_default) ?? d[0] ?? null); }).catch(() => setList([])); }, []);
  React.useEffect(() => { analytics.overview().then(setOverview).catch(() => setOverview(null)); }, []);
  return (
    <div className="space-y-3">
      {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}>New dashboard</Button></div>}
      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <Card><CardBody className="space-y-1">
          {list === null ? <Skeleton className="h-8" /> : list.length === 0 ? <EmptyState title="No dashboards" /> : list.map((d) => (
            <button key={d.id} onClick={() => setActive(d)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${active?.id === d.id ? 'bg-brand/15 text-brand' : 'hover:bg-surface-2 text-fg'}`}>
              {d.name}{d.is_default && <span className="ml-2 text-xs text-muted">default</span>}
            </button>
          ))}
        </CardBody></Card>
        <Card><CardBody>
          {!active ? <EmptyState title="Select a dashboard" /> : (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{active.name}</h2>
              <div className="grid gap-4">{active.layout.map((w, i) => <DashboardWidget key={`${i}:${w.type}`} type={w.type} overview={overview} />)}</div>
            </div>
          )}
        </CardBody></Card>
      </div>
      {creating && <NewDashboardModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); dashboardsApi.list().then((all) => { setList(all); setActive(all.find((x) => x.id === d.id) ?? d); }).catch(() => {}); }} />}
    </div>
  );
}

const WIDGETS = ['kpis', 'ticket_volume', 'posture_gauge', 'top_findings', 'sla_breaches', 'recent_tickets'] as const;
const WIDGET_NAME: Record<string, string> = { kpis: 'KPI cards', ticket_volume: 'Ticket volume', posture_gauge: 'Posture gauge', top_findings: 'Top findings', sla_breaches: 'SLA', recent_tickets: 'Recent tickets' };

function NewDashboardModal({ orgs, isAgent, onClose, onCreated }: { orgs: { id: string; name: string }[]; isAgent: boolean; onClose: () => void; onCreated: (d: Dashboard) => void }) {
  const [name, setName] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [picked, setPicked] = React.useState<string[]>(['kpis', 'recent_tickets']);
  const [err, setErr] = React.useState('');
  function toggle(w: string) { setPicked((p) => p.includes(w) ? p.filter((x) => x !== w) : [...p, w]); }
  async function save() {
    try {
      const d = await dashboardsApi.create({ name, layout: picked.map((type) => ({ type })), ...(isAgent ? { organizationId } : {}) });
      onCreated(d);
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardBody className="space-y-3">
          <h2 className="text-lg font-semibold">New dashboard</h2>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {isAgent && <Field label="Organization"><select title="Organization" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
          <div><div className="mb-1 text-xs font-medium text-muted">Widgets</div>
            <div className="grid grid-cols-2 gap-1.5">
              {WIDGETS.map((w) => <label key={w} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(w)} onChange={() => toggle(w)} /> {WIDGET_NAME[w]}</label>)}
            </div>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name || picked.length === 0 || (isAgent && !organizationId)}>Create</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
