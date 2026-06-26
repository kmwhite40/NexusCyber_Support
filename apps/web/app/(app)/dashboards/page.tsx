'use client';
import React from 'react';
import Link from 'next/link';
import {
  api, analytics, dashboardsApi,
  type Dashboard, type AnalyticsOverview, type OperationalKpis,
  type CustomerPortfolioRow, type PostureCompliance, type OpsSummary, type DeliveryHealth,
} from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Field, Select, Checkbox, SegmentedControl } from '@/components/ui/primitives';
import { StatCard, EmptyState, Skeleton } from '@/components/ui/data';
import { Donut, MiniBars, TrendChart } from '@/components/ui/charts';
import { DashboardWidget } from '@/components/ui/dashboard-widgets';

type Tab = 'executive' | 'sla' | 'operations' | 'agents' | 'customers' | 'posture' | 'serviceops' | 'notifications' | 'custom';
const ALL_TABS: { id: Tab; label: string; hint: string; agentOnly?: boolean }[] = [
  { id: 'executive', label: 'Executive KPIs', hint: 'Backlog, throughput, MTTR, CSAT' },
  { id: 'sla', label: 'SLA performance', hint: 'Response & resolution attainment' },
  { id: 'operations', label: 'Ticket operations', hint: 'Opened vs closed, backlog' },
  { id: 'agents', label: 'Team performance', hint: 'Agent throughput, CSAT, SLA' },
  { id: 'customers', label: 'Customer portfolio', hint: 'Per-tenant health (MSP)', agentOnly: true },
  { id: 'posture', label: 'Posture & compliance', hint: 'Findings, ConMon, NIST controls' },
  { id: 'serviceops', label: 'On-call & change', hint: 'Paging, MTTA, change pipeline', agentOnly: true },
  { id: 'notifications', label: 'Notifications', hint: 'Email/notification delivery health', agentOnly: true },
  { id: 'custom', label: 'Custom', hint: 'Your saved dashboards' },
];
const PERIODS = [7, 30, 90];
const USES_KPIS: Tab[] = ['executive', 'sla', 'operations'];
const USES_ORG: Tab[] = ['executive', 'sla', 'operations', 'posture', 'serviceops'];
const PRIORITY_COLOR: Record<string, string> = { P1: 'hsl(var(--danger))', P2: 'hsl(var(--warning))', P3: 'hsl(var(--brand))', P4: 'hsl(var(--muted))' };
const SEV_COLOR: Record<string, string> = { critical: 'hsl(var(--danger))', high: 'hsl(var(--danger))', moderate: 'hsl(var(--warning))', low: 'hsl(var(--muted))', info: 'hsl(var(--brand))' };
const tone = (p: number): 'success' | 'warning' | 'danger' => (p >= 90 ? 'success' : p >= 75 ? 'warning' : 'danger');
const fmtDays = (n: number) => (n >= 1 ? `${n.toFixed(1)}d` : `${Math.round(n * 24)}h`);
const SkeletonGrid = () => <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;

export default function DashboardsPage() {
  const { can, me } = useAuth();
  const isAgent = me?.plane === 'nexus';
  const tabs = ALL_TABS.filter((t) => !t.agentOnly || isAgent);
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
    if (!USES_KPIS.includes(tab)) return;
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
            Operational analytics across tickets, SLAs, security posture, and team throughput.{' '}
            <Link className="text-brand hover:underline" href="/analytics">Deep-dive analytics →</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAgent && USES_ORG.includes(tab) && (
            <Select title="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)} className="h-9 w-auto">
              <option value="">{tab === 'posture' || tab === 'serviceops' ? 'Select customer…' : 'All customers'}</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          )}
          {USES_KPIS.includes(tab) && (
            <SegmentedControl<string>
              size="sm"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={PERIODS.map((p) => ({ value: String(p), label: `${p}d` }))}
            />
          )}
        </div>
      </div>

      <SegmentedControl<Tab>
        className="flex-wrap"
        value={tab}
        onChange={setTab}
        options={tabs.map((t) => ({ value: t.id, label: <span title={t.hint}>{t.label}</span> }))}
      />

      {tab === 'custom' ? <CustomDashboards isAgent={isAgent} orgs={orgs} canManage={can('dashboard.manage')} />
        : tab === 'agents' ? <TeamPerformance />
        : tab === 'customers' ? <CustomerPortfolio />
        : tab === 'posture' ? <PostureCompliancePanel orgId={orgId} isAgent={isAgent} />
        : tab === 'serviceops' ? <ServiceOps orgId={orgId} />
        : tab === 'notifications' ? <NotificationHealth />
        : loading ? <SkeletonGrid />
        : !kpis ? <EmptyState title="No analytics available" description="You may not have reporting permission for this view." />
        : tab === 'executive' ? <Executive kpis={kpis} />
        : tab === 'sla' ? <SlaPerformance kpis={kpis} overview={overview} />
        : <Operations kpis={kpis} />}
    </div>
  );
}

function Executive({ kpis }: { kpis: OperationalKpis }) {
  const s = kpis.summary;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open tickets" value={s.open} tone="brand" delta={s.open_p1 ? { value: `${s.open_p1} P1 open`, positive: false } : undefined} />
        <StatCard label="Opened today" value={s.opened_today} tone="accent" />
        <StatCard label="Closed today" value={s.closed_today} tone="success" />
        <StatCard label="SLA attainment" value={`${kpis.sla.overallAttainmentPct}%`} tone={tone(kpis.sla.overallAttainmentPct)} />
        <StatCard label="Mean time to resolve" value={fmtDays(s.mttr_days)} tone="brand" />
        <StatCard label="CSAT (avg)" value={s.csat ? `${s.csat.toFixed(2)} / 5` : '—'} tone="warning" />
        <StatCard label="Opened this week" value={s.opened_week} tone="accent" />
        <StatCard label="Closed this week" value={s.closed_week} tone="success" />
      </div>
      <Card><CardHeader><CardTitle>Tickets opened vs closed · last {kpis.days} days</CardTitle></CardHeader><CardBody><TrendChart data={kpis.trend} /></CardBody></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Open backlog by priority</CardTitle></CardHeader><CardBody>{kpis.byPriority.length ? <MiniBars items={kpis.byPriority.map((b) => ({ label: b.label, value: b.count, color: PRIORITY_COLOR[b.label] }))} /> : <EmptyState title="No open tickets" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>Open backlog by status</CardTitle></CardHeader><CardBody>{kpis.byStatus.length ? <MiniBars items={kpis.byStatus.map((b) => ({ label: b.label.replace(/_/g, ' '), value: b.count }))} /> : <EmptyState title="No open tickets" />}</CardBody></Card>
      </div>
    </div>
  );
}

function SlaPerformance({ kpis, overview }: { kpis: OperationalKpis; overview: AnalyticsOverview | null }) {
  const sla = kpis.sla;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Overall attainment" value={`${sla.overallAttainmentPct}%`} tone={tone(sla.overallAttainmentPct)} />
        <StatCard label="Response attainment" value={`${sla.responseAttainmentPct}%`} tone={tone(sla.responseAttainmentPct)} delta={{ value: `${sla.responseBreached} breached`, positive: sla.responseBreached === 0 }} />
        <StatCard label="Resolution attainment" value={`${sla.resolutionAttainmentPct}%`} tone={tone(sla.resolutionAttainmentPct)} delta={{ value: `${sla.resolutionBreached} breached`, positive: sla.resolutionBreached === 0 }} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>SLA outcomes (met vs breached)</CardTitle></CardHeader><CardBody>
          <Donut size={190} centerLabel="attainment" centerValue={`${sla.overallAttainmentPct}%`} segments={[{ label: 'Met', value: sla.responseMet + sla.resolutionMet, color: 'hsl(var(--success))' }, { label: 'Breached', value: sla.responseBreached + sla.resolutionBreached, color: 'hsl(var(--danger))' }]} />
        </CardBody></Card>
        <Card><CardHeader><CardTitle>Within-SLA by category</CardTitle></CardHeader><CardBody>
          {overview?.byCategory?.length ? <MiniBars items={overview.byCategory.slice(0, 8).map((c) => ({ label: c.category, value: Math.round(c.withinSlaPct), color: c.withinSlaPct >= 90 ? 'hsl(var(--success))' : c.withinSlaPct >= 75 ? 'hsl(var(--warning))' : 'hsl(var(--danger))' }))} /> : <EmptyState title="No category data" />}
        </CardBody></Card>
      </div>
      <Card><CardHeader><CardTitle>Throughput · last {kpis.days} days</CardTitle></CardHeader><CardBody><TrendChart data={kpis.trend} /></CardBody></Card>
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
      <Card><CardHeader><CardTitle>Tickets opened vs closed · last {kpis.days} days</CardTitle></CardHeader><CardBody><TrendChart data={kpis.trend} height={220} /></CardBody></Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle>Backlog by status</CardTitle></CardHeader><CardBody>{kpis.byStatus.length ? <MiniBars items={kpis.byStatus.map((b) => ({ label: b.label.replace(/_/g, ' '), value: b.count }))} /> : <EmptyState title="None open" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>Backlog by priority</CardTitle></CardHeader><CardBody>{kpis.byPriority.length ? <MiniBars items={kpis.byPriority.map((b) => ({ label: b.label, value: b.count, color: PRIORITY_COLOR[b.label] }))} /> : <EmptyState title="None open" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>Backlog by age</CardTitle></CardHeader><CardBody>{kpis.byAge.length ? <MiniBars items={kpis.byAge.map((b) => ({ label: b.label, value: b.count, color: b.label === '> 7 days' ? 'hsl(var(--danger))' : b.label === '3-7 days' ? 'hsl(var(--warning))' : 'hsl(var(--brand))' }))} /> : <EmptyState title="None open" />}</CardBody></Card>
      </div>
    </div>
  );
}

function TeamPerformance() {
  const [o, setO] = React.useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { analytics.overview().then(setO).catch(() => setO(null)).finally(() => setLoading(false)); }, []);
  if (loading) return <SkeletonGrid />;
  if (!o) return <EmptyState title="No analytics available" />;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active agents" value={o.kpis.totalAgents} tone="brand" />
        <StatCard label="Avg resolution" value={fmtDays(o.kpis.avgResolutionDays)} tone="accent" />
        <StatCard label="Within SLA" value={`${Math.round(o.kpis.withinSlaPct)}%`} tone={tone(o.kpis.withinSlaPct)} />
        <StatCard label="Avg CSAT" value={o.kpis.avgRating ? `${o.kpis.avgRating.toFixed(2)} / 5` : '—'} tone="warning" />
      </div>
      <Card><CardHeader><CardTitle>Agent leaderboard</CardTitle></CardHeader><CardBody>
        {o.agents.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">Agent</th><th className="px-3 text-right">Tickets</th><th className="px-3 text-right">Avg resolve</th><th className="px-3 text-right">Within SLA</th><th className="pl-3 text-right">CSAT</th>
              </tr></thead>
              <tbody>
                {o.agents.slice(0, 12).map((a) => (
                  <tr key={a.agentId} className="border-b border-border/60">
                    <td className="py-2 pr-3 text-fg">{a.name}</td>
                    <td className="px-3 text-right tabular-nums">{a.tickets}</td>
                    <td className="px-3 text-right tabular-nums">{fmtDays(a.avgResolutionDays)}</td>
                    <td className={`px-3 text-right tabular-nums ${a.withinSlaPct >= 90 ? 'text-success' : a.withinSlaPct >= 75 ? 'text-warning' : 'text-danger'}`}>{Math.round(a.withinSlaPct)}%</td>
                    <td className="pl-3 text-right tabular-nums">{a.avgRating ? a.avgRating.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No agent activity yet" />}
      </CardBody></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Top by volume</CardTitle></CardHeader><CardBody>{o.topByTickets.length ? <MiniBars items={o.topByTickets.map((a) => ({ label: a.name, value: a.tickets }))} /> : <EmptyState title="No data" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>Top rated (CSAT)</CardTitle></CardHeader><CardBody>{o.topRated.length ? <MiniBars items={o.topRated.map((a) => ({ label: a.name, value: Math.round(a.avgRating * 20), color: 'hsl(var(--success))' }))} /> : <EmptyState title="No ratings yet" />}</CardBody></Card>
      </div>
    </div>
  );
}

function CustomerPortfolio() {
  const [rows, setRows] = React.useState<CustomerPortfolioRow[] | null>(null);
  React.useEffect(() => { analytics.customerPortfolio().then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return <SkeletonGrid />;
  if (!rows.length) return <EmptyState title="No customers" />;
  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const totalP1 = rows.reduce((s, r) => s + r.open_p1, 0);
  const atRisk = rows.filter((r) => r.slaAttainmentPct < 90).length;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Customers" value={rows.length} tone="brand" />
        <StatCard label="Total open" value={totalOpen} tone="accent" />
        <StatCard label="Open P1s" value={totalP1} tone={totalP1 ? 'danger' : 'success'} />
        <StatCard label="SLA at-risk tenants" value={atRisk} tone={atRisk ? 'warning' : 'success'} />
      </div>
      <Card><CardHeader><CardTitle>Customer health</CardTitle></CardHeader><CardBody>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-3">Customer</th><th className="px-3 text-right">Open</th><th className="px-3 text-right">P1</th><th className="px-3 text-right">Opened 7d</th><th className="px-3 text-right">Closed 7d</th><th className="px-3 text-right">SLA</th><th className="pl-3 text-right">CSAT</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="py-2 pr-3 text-fg">{r.name}</td>
                  <td className="px-3 text-right tabular-nums">{r.open}</td>
                  <td className={`px-3 text-right tabular-nums ${r.open_p1 ? 'text-danger' : ''}`}>{r.open_p1}</td>
                  <td className="px-3 text-right tabular-nums">{r.opened_7d}</td>
                  <td className="px-3 text-right tabular-nums">{r.closed_7d}</td>
                  <td className={`px-3 text-right tabular-nums ${r.slaAttainmentPct >= 90 ? 'text-success' : r.slaAttainmentPct >= 75 ? 'text-warning' : 'text-danger'}`}>{r.slaAttainmentPct}%</td>
                  <td className="pl-3 text-right tabular-nums">{r.csat ? r.csat.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody></Card>
    </div>
  );
}

function PostureCompliancePanel({ orgId, isAgent }: { orgId: string; isAgent: boolean }) {
  const [d, setD] = React.useState<PostureCompliance | null>(null);
  const [loading, setLoading] = React.useState(true);
  const needsOrg = isAgent && !orgId;
  React.useEffect(() => {
    if (needsOrg) { setLoading(false); return; }
    setLoading(true);
    analytics.postureCompliance(orgId || undefined).then(setD).catch(() => setD(null)).finally(() => setLoading(false));
  }, [orgId, needsOrg]);
  if (needsOrg) return <EmptyState title="Select a customer" description="Choose a customer above to view its posture & compliance." />;
  if (loading) return <SkeletonGrid />;
  if (!d) return <EmptyState title="No posture data" />;
  const conmonColor: Record<string, string> = { pass: 'hsl(var(--success))', finding: 'hsl(var(--danger))', error: 'hsl(var(--warning))' };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open findings" value={d.totals.open} tone="brand" delta={d.totals.open_high ? { value: `${d.totals.open_high} crit/high`, positive: false } : undefined} />
        <StatCard label="Overdue remediation" value={d.totals.overdue} tone={d.totals.overdue ? 'danger' : 'success'} />
        <StatCard label="Remediated" value={d.totals.remediated} tone="success" />
        <StatCard label="Control coverage" value={`${d.compliance.satisfiedPct}%`} tone={tone(d.compliance.satisfiedPct)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Open findings by severity</CardTitle></CardHeader><CardBody>{d.sev.length ? <MiniBars items={d.sev.map((s) => ({ label: s.label, value: s.count, color: SEV_COLOR[s.label] }))} /> : <EmptyState title="No open findings" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>ConMon latest results</CardTitle></CardHeader><CardBody>{d.conmon.length ? <MiniBars items={d.conmon.map((c) => ({ label: c.label, value: c.count, color: conmonColor[c.label] }))} /> : <EmptyState title="No ConMon runs" />}</CardBody></Card>
      </div>
      <Card><CardHeader><CardTitle>NIST control coverage by family</CardTitle></CardHeader><CardBody>
        {d.compliance.families.length ? (
          <div className="space-y-2.5">
            {d.compliance.families.map((f) => {
              const total = f.satisfied + f.partial + f.gap || 1;
              return (
                <div key={f.family} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-xs text-muted" title={f.family}>{f.family}</span>
                  <div className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div style={{ width: `${(f.satisfied / total) * 100}%`, background: 'hsl(var(--success))' }} />
                    <div style={{ width: `${(f.partial / total) * 100}%`, background: 'hsl(var(--warning))' }} />
                    <div style={{ width: `${(f.gap / total) * 100}%`, background: 'hsl(var(--danger))' }} />
                  </div>
                  <span className="w-20 text-right text-xs tabular-nums text-muted">{f.satisfied}/{f.satisfied + f.partial + f.gap}</span>
                </div>
              );
            })}
            <div className="flex gap-4 pt-1 text-xs text-muted">
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ background: 'hsl(var(--success))' }} />Satisfied</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ background: 'hsl(var(--warning))' }} />Partial</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ background: 'hsl(var(--danger))' }} />Gap</span>
            </div>
          </div>
        ) : <EmptyState title="No control mappings" description="Compliance controls are not configured for this customer." />}
      </CardBody></Card>
    </div>
  );
}

function ServiceOps({ orgId }: { orgId: string }) {
  const [d, setD] = React.useState<OpsSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { setLoading(true); analytics.opsSummary(orgId || undefined).then(setD).catch(() => setD(null)).finally(() => setLoading(false)); }, [orgId]);
  if (loading) return <SkeletonGrid />;
  if (!d) return <EmptyState title="No operations data" />;
  const ackRate = d.pages.total ? Math.round((d.pages.acknowledged / d.pages.total) * 100) : 100;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pages (total)" value={d.pages.total} tone="brand" delta={{ value: `${d.pages.last_7d} in 7d`, positive: true }} />
        <StatCard label="Mean time to ack" value={d.pages.mttaMin ? `${d.pages.mttaMin} min` : '—'} tone="accent" />
        <StatCard label="Ack rate" value={`${ackRate}%`} tone={tone(ackRate)} />
        <StatCard label="Escalated pages" value={d.pages.escalated} tone={d.pages.escalated ? 'warning' : 'success'} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Changes in CAB" value={d.change.in_cab} tone="brand" />
        <StatCard label="Approved / scheduled" value={d.change.approved} tone="success" />
        <StatCard label="Upcoming windows" value={d.change.upcoming} tone="accent" />
        <StatCard label="Rejected" value={d.change.rejected} tone={d.change.rejected ? 'danger' : 'success'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Pages by state</CardTitle></CardHeader><CardBody>
          <MiniBars items={[
            { label: 'open', value: d.pages.open },
            { label: 'acknowledged', value: d.pages.acknowledged, color: 'hsl(var(--success))' },
            { label: 'escalated', value: d.pages.escalated, color: 'hsl(var(--danger))' },
          ]} />
        </CardBody></Card>
        <Card><CardHeader><CardTitle>Changes by type</CardTitle></CardHeader><CardBody>{d.change.byType.length ? <MiniBars items={d.change.byType.map((c) => ({ label: c.label, value: c.count, color: c.label === 'emergency' ? 'hsl(var(--danger))' : c.label === 'normal' ? 'hsl(var(--brand))' : 'hsl(var(--muted))' }))} /> : <EmptyState title="No changes" />}</CardBody></Card>
      </div>
    </div>
  );
}

function NotificationHealth() {
  const [d, setD] = React.useState<DeliveryHealth | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { analytics.notificationHealth(7).then(setD).catch(() => setD(null)).finally(() => setLoading(false)); }, []);
  if (loading) return <SkeletonGrid />;
  if (!d) return <EmptyState title="No delivery data" />;
  const t = d.totals;
  const deliveredPct = t.total ? Math.round((t.sent / t.total) * 100) : 100;
  const STATUS_COLOR: Record<string, string> = { sent: 'hsl(var(--success))', substituted: 'hsl(var(--warning))', skipped: 'hsl(var(--muted))', failed: 'hsl(var(--danger))' };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Deliveries (7d)" value={t.total} tone="brand" />
        <StatCard label="Sent" value={t.sent} tone="success" delta={{ value: `${deliveredPct}% of total`, positive: deliveredPct >= 90 }} />
        <StatCard label="Substituted / skipped" value={t.substituted + t.skipped} tone={t.substituted + t.skipped ? 'warning' : 'success'} />
        <StatCard label="Failed" value={t.failed} tone={t.failed ? 'danger' : 'success'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>By status</CardTitle></CardHeader><CardBody>{d.byStatus.length ? <MiniBars items={d.byStatus.map((s) => ({ label: s.label, value: s.count, color: STATUS_COLOR[s.label] }))} /> : <EmptyState title="No deliveries" />}</CardBody></Card>
        <Card><CardHeader><CardTitle>By channel</CardTitle></CardHeader><CardBody>{d.byChannel.length ? <MiniBars items={d.byChannel.map((c) => ({ label: c.label, value: c.count }))} /> : <EmptyState title="No deliveries" />}</CardBody></Card>
      </div>
      <Card><CardHeader><CardTitle>Recent issues (substituted / skipped / failed)</CardTitle></CardHeader><CardBody>
        {d.recentIssues.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">When</th><th className="px-3">Event</th><th className="px-3">Channel</th><th className="px-3">Status</th><th className="pl-3">Reason</th>
              </tr></thead>
              <tbody>
                {d.recentIssues.map((r, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted">{r.created_at.slice(5, 16).replace('T', ' ')}</td>
                    <td className="px-3">{r.event_type}</td>
                    <td className="px-3">{r.channel}</td>
                    <td className={`px-3 ${r.status === 'failed' ? 'text-danger' : 'text-warning'}`}>{r.status}</td>
                    <td className="pl-3 text-muted">{r.substitution_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No delivery issues" description="All notifications in the last 7 days were delivered." />}
      </CardBody></Card>
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
            <button key={d.id} type="button" onClick={() => setActive(d)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${active?.id === d.id ? 'bg-brand/15 text-brand' : 'hover:bg-surface-2 text-fg'}`}>
              {d.name}{d.is_default && <span className="ml-2 text-xs text-muted">default</span>}
            </button>
          ))}
        </CardBody></Card>
        <Card><CardBody>
          {!active ? <EmptyState title="Select a dashboard" /> : (
            <div className="space-y-3">
              <CardTitle className="text-lg">{active.name}</CardTitle>
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
          <CardTitle className="text-lg">New dashboard</CardTitle>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {isAgent && <Field label="Organization"><Select title="Organization" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>}
          <div><div className="mb-1 text-xs font-medium text-muted">Widgets</div>
            <div className="grid grid-cols-2 gap-1.5">
              {WIDGETS.map((w) => <label key={w} className="flex items-center gap-2 text-sm"><Checkbox checked={picked.includes(w)} onChange={() => toggle(w)} /> {WIDGET_NAME[w]}</label>)}
            </div>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name || picked.length === 0 || (isAgent && !organizationId)}>Create</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
