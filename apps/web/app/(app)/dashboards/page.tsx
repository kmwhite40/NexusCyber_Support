'use client';
import React from 'react';
import Link from 'next/link';
import { dashboardsApi, type Dashboard } from '@/lib/api';
import { Card, CardBody, Badge } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';

const WIDGET_LABEL: Record<string, string> = {
  kpis: 'KPI cards', ticket_volume: 'Ticket volume', posture_gauge: 'Posture gauge',
  top_findings: 'Top posture findings', sla_breaches: 'SLA breaches', recent_tickets: 'Recent tickets',
};

export default function DashboardsPage() {
  const [list, setList] = React.useState<Dashboard[] | null>(null);
  const [active, setActive] = React.useState<Dashboard | null>(null);
  React.useEffect(() => { dashboardsApi.list().then((d) => { setList(d); setActive(d.find((x) => x.is_default) ?? d[0] ?? null); }).catch(() => setList([])); }, []);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1><p className="mt-1 text-sm text-muted">Named dashboards. The rich live overview is at <Link className="text-brand hover:underline" href="/dashboard">/dashboard</Link>.</p></div>
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
              <div className="grid gap-3 sm:grid-cols-2">
                {active.layout.map((w, i) => (
                  <div key={i} className="rounded-lg border border-border bg-surface-2 px-4 py-6 text-center"><Badge>{WIDGET_LABEL[w.type] ?? w.type}</Badge></div>
                ))}
              </div>
            </div>
          )}
        </CardBody></Card>
      </div>
    </div>
  );
}
