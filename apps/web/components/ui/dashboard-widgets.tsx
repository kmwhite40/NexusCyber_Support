'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket, type AnalyticsOverview } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { StatCard, Skeleton, EmptyState } from '@/components/ui/data';

export type { AnalyticsOverview as Overview };

const WIDGET_LABEL: Record<string, string> = {
  kpis: 'KPIs', ticket_volume: 'Ticket volume', posture_gauge: 'Security posture',
  top_findings: 'Top posture findings', sla_breaches: 'SLA', recent_tickets: 'Recent tickets',
};

export function DashboardWidget({ type, overview }: { type: string; overview: AnalyticsOverview | null }) {
  if (type === 'kpis') {
    if (!overview) return <Skeleton className="h-20" />;
    const k = overview.kpis;
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total tickets" value={k.totalTickets} />
        <StatCard label="Within SLA" value={`${k.withinSlaPct}%`} />
        <StatCard label="Avg resolution (d)" value={k.avgResolutionDays} />
        <StatCard label="Avg rating" value={k.avgRating} />
      </div>
    );
  }
  if (type === 'sla_breaches') {
    if (!overview) return <Skeleton className="h-20" />;
    const k = overview.kpis;
    const breaches = Math.max(0, Math.round(k.totalTickets * (1 - k.withinSlaPct / 100)));
    return (
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Within SLA" value={`${k.withinSlaPct}%`} />
        <StatCard label="Breached (approx)" value={breaches} />
      </div>
    );
  }
  if (type === 'ticket_volume') {
    if (!overview) return <Skeleton className="h-20" />;
    const max = Math.max(1, ...overview.volumeByYear.map((v) => v.count));
    return (
      <Card><CardBody>
        <div className="mb-2 text-xs font-medium text-muted">Ticket volume by year</div>
        <div className="space-y-1">
          {overview.volumeByYear.map((v) => (
            <div key={v.year} className="flex items-center gap-2 text-xs">
              <span className="w-10 tabular-nums text-muted">{v.year}</span>
              <div className="h-2 rounded bg-brand" style={{ width: `${(v.count / max) * 100}%` }} />
              <span className="tabular-nums text-fg">{v.count}</span>
            </div>
          ))}
        </div>
      </CardBody></Card>
    );
  }
  if (type === 'posture_gauge') return <PostureGauge />;
  if (type === 'top_findings') return <TopFindings />;
  if (type === 'recent_tickets') return <RecentTickets />;
  return <Card><CardBody><EmptyState title={WIDGET_LABEL[type] ?? type} /></CardBody></Card>;
}

function PostureGauge() {
  const [s, setS] = React.useState<{ overall_score: number; grade: string } | null>(null);
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    api.get<{ overall_score: number; grade: string }>('/posture/score')
      .then(setS)
      .catch(() => {})
      .finally(() => setDone(true));
  }, []);
  if (!done) return <Skeleton className="h-20" />;
  if (!s) return <Card><CardBody><EmptyState title="Posture unavailable" /></CardBody></Card>;
  return (
    <div className="grid grid-cols-2 gap-3">
      <StatCard label="Posture score" value={s.overall_score} />
      <StatCard label="Grade" value={s.grade} />
    </div>
  );
}

interface FindingRow { id: string; title: string; severity: string; status: string; }

function TopFindings() {
  const [rows, setRows] = React.useState<FindingRow[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: FindingRow[] }>('/posture/findings')
      .then((r) => setRows(r.data.slice(0, 5)))
      .catch(() => setRows([]));
  }, []);
  if (rows === null) return <Skeleton className="h-20" />;
  return (
    <Card><CardBody>
      <div className="mb-2 text-xs font-medium text-muted">Top posture findings</div>
      {rows.length === 0 ? <EmptyState title="No findings" /> : (
        <ul className="space-y-1 text-sm">
          {rows.map((f) => (
            <li key={f.id} className="flex justify-between gap-2">
              <span className="truncate text-fg">{f.title}</span>
              <span className="text-muted">{f.severity}</span>
            </li>
          ))}
        </ul>
      )}
    </CardBody></Card>
  );
}

function RecentTickets() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?limit=8')
      .then((r) => setRows(r.data))
      .catch(() => setRows([]));
  }, []);
  if (rows === null) return <Skeleton className="h-20" />;
  return (
    <Card><CardBody>
      <div className="mb-2 text-xs font-medium text-muted">Recent tickets</div>
      {rows.length === 0 ? <EmptyState title="No tickets" /> : (
        <ul className="space-y-1 text-sm">
          {rows.map((t) => (
            <li key={t.id}>
              <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link>{' '}
              <span className="text-muted">{t.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </CardBody></Card>
  );
}
