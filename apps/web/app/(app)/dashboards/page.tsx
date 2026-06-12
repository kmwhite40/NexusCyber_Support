'use client';
import React from 'react';
import Link from 'next/link';
import { api, dashboardsApi, type Dashboard, type AnalyticsOverview } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Input, Field } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';
import { DashboardWidget } from '@/components/ui/dashboard-widgets';

const WIDGETS = ['kpis', 'ticket_volume', 'posture_gauge', 'top_findings', 'sla_breaches', 'recent_tickets'] as const;
const WIDGET_NAME: Record<string, string> = { kpis: 'KPI cards', ticket_volume: 'Ticket volume', posture_gauge: 'Posture gauge', top_findings: 'Top findings', sla_breaches: 'SLA', recent_tickets: 'Recent tickets' };

export default function DashboardsPage() {
  const { can, me } = useAuth();
  const [list, setList] = React.useState<Dashboard[] | null>(null);
  const [active, setActive] = React.useState<Dashboard | null>(null);
  const [overview, setOverview] = React.useState<AnalyticsOverview | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const isAgent = me?.plane === 'nexus';
  const canManage = can('dashboard.manage');
  React.useEffect(() => { dashboardsApi.list().then((d) => { setList(d); setActive(d.find((x) => x.is_default) ?? d[0] ?? null); }).catch(() => setList([])); }, []);
  React.useEffect(() => { api.get<AnalyticsOverview>('/analytics/overview').then(setOverview).catch(() => setOverview(null)); }, []);
  React.useEffect(() => { if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {}); }, [isAgent]);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1><p className="mt-1 text-sm text-muted">Named dashboards. The rich live overview is at <Link className="text-brand hover:underline" href="/dashboard">/dashboard</Link>.</p></div>
        {canManage && <Button onClick={() => setCreating(true)}>New dashboard</Button>}
      </div>
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
              <div className="grid gap-4">
                {active.layout.map((w, i) => <DashboardWidget key={i} type={w.type} overview={overview} />)}
              </div>
            </div>
          )}
        </CardBody></Card>
      </div>
      {creating && (
        <NewDashboardModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); dashboardsApi.list().then((all) => { setList(all); setActive(all.find((x) => x.id === d.id) ?? d); }); }} />
      )}
    </div>
  );
}

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
