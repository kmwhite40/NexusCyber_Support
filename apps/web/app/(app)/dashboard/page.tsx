'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type Ticket, type Finding } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';
import { StatCard, DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { ScoreGauge, Sparkline, MiniBars } from '@/components/ui/charts';
import { PriorityBadge, StatusBadge, SeverityBadge } from '@/components/ui/badges';
import { Plus, ArrowRight } from 'lucide-react';

export default function DashboardPage() {
  const { me, can } = useAuth();
  const router = useRouter();
  const [tickets, setTickets] = React.useState<Ticket[] | null>(null);
  const [findings, setFindings] = React.useState<Finding[] | null>(null);
  const [score, setScore] = React.useState<{ overall_score: number; grade: string } | null>(null);

  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?limit=8').then((r) => setTickets(r.data)).catch(() => setTickets([]));
    if (can('posture.read')) {
      api.get<{ overall_score: number; grade: string }>('/posture/score').then(setScore).catch(() => {});
      api.get<{ data: Finding[] }>('/posture/findings').then((r) => setFindings(r.data)).catch(() => setFindings([]));
    } else {
      setFindings([]);
    }
  }, [can]);

  const open = tickets?.filter((t) => !['resolved', 'closed'].includes(t.status)) ?? [];
  const breaching = (tickets ?? []).filter((t) => t.slas?.some((s) => s.state === 'breached'));

  const sevCounts = (findings ?? []).reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {me?.plane === 'nexus' ? 'Operations overview' : 'Welcome back'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {me?.plane === 'nexus'
              ? 'Cross-customer view of your assigned organizations.'
              : 'Your support requests and security posture at a glance.'}
          </p>
        </div>
        <Button onClick={() => router.push('/tickets/new')}>
          <Plus className="h-4 w-4" strokeWidth={1.75} /> New ticket
        </Button>
      </div>

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open tickets" value={tickets ? open.length : '—'} tone="brand" icon={<Dot />} />
        <StatCard label="SLA breaching" value={tickets ? breaching.length : '—'} tone="danger" icon={<Dot />} />
        <StatCard label="Posture score" value={score ? Math.round(score.overall_score) : can('posture.read') ? '—' : 'n/a'} tone="success" icon={<Dot />} />
        <StatCard label="Open findings" value={findings ? findings.filter((f) => !['remediated', 'closed', 'accepted'].includes(f.status)).length : '—'} tone="warning" icon={<Dot />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Tickets */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Recent tickets</CardTitle>
            <Link href="/tickets" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">View all <ArrowRight className="h-4 w-4" strokeWidth={1.75} /></Link>
          </CardHeader>
          <CardBody className="px-0">
            {!tickets ? (
              <div className="space-y-2 px-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              <DataTable<Ticket>
                rows={tickets.slice(0, 6)}
                onRowClick={(t) => router.push(`/tickets/${t.id}`)}
                empty={<EmptyState title="No tickets yet" description="Submit your first request to get started." action={<Button size="sm" onClick={() => router.push('/tickets/new')}>New ticket</Button>} />}
                columns={[
                  { key: 'num', header: 'Ticket', render: (t) => <span className="font-mono text-xs text-muted">{t.ticket_number}</span> },
                  { key: 'subject', header: 'Subject', render: (t) => <span className="font-medium text-fg">{t.subject}</span> },
                  { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
                  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
                ]}
              />
            )}
          </CardBody>
        </Card>

        {/* Posture */}
        <Card>
          <CardHeader><CardTitle>Security posture</CardTitle></CardHeader>
          <CardBody>
            {!can('posture.read') ? (
              <EmptyState title="Posture not available" description="Your role does not include posture visibility." />
            ) : !score ? (
              <div className="flex justify-center py-6"><Skeleton className="h-40 w-40 rounded-full" /></div>
            ) : (
              <>
                <div className="flex flex-col items-center">
                  <ScoreGauge score={score.overall_score} />
                  <div className="mt-3"><Badge tone={score.overall_score >= 80 ? 'success' : score.overall_score >= 60 ? 'warning' : 'danger'}>Grade {score.grade}</Badge></div>
                </div>
                <div className="mt-5">
                  <div className="mb-2 text-xs font-medium text-muted">Findings by severity</div>
                  <MiniBars
                    items={[
                      { label: 'Critical', value: sevCounts.critical ?? 0, color: 'hsl(var(--danger))' },
                      { label: 'High', value: sevCounts.high ?? 0, color: 'hsl(var(--warning))' },
                      { label: 'Moderate', value: sevCounts.moderate ?? 0, color: 'hsl(var(--accent))' },
                      { label: 'Low', value: sevCounts.low ?? 0, color: 'hsl(var(--muted))' },
                    ]}
                  />
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Trend + findings preview */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <CardTitle>Ticket volume (14d)</CardTitle>
            {/* Says so at a glance, not only in the footnote. Sitting beside four cards of real
                numbers, an unlabelled sample chart is read as real by everyone who does not
                stop to read underneath it. */}
            <Badge tone="warning">Sample data</Badge>
          </CardHeader>
          <CardBody>
            <Sparkline data={[4, 6, 5, 8, 7, 9, 6, 10, 8, 12, 9, 11, 7, 10]} width={260} height={64} />
            <p className="mt-2 text-xs text-muted">Demonstration trend — wired to analytics ETL in Enterprise v1.</p>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Top posture findings</CardTitle>
            {can('posture.read') && <Link href="/posture" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">Open posture <ArrowRight className="h-4 w-4" strokeWidth={1.75} /></Link>}
          </CardHeader>
          <CardBody className="px-0">
            {!findings ? (
              <div className="space-y-2 px-5">{[0, 1].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : (
              <DataTable<Finding>
                rows={findings.slice(0, 5)}
                onRowClick={() => router.push('/posture')}
                empty={<EmptyState title="No findings" description="Nothing outstanding — nice." />}
                columns={[
                  { key: 'sev', header: 'Severity', render: (f) => <SeverityBadge severity={f.severity} /> },
                  { key: 'title', header: 'Finding', render: (f) => <span className="font-medium text-fg">{f.title}</span> },
                  { key: 'domain', header: 'Domain', render: (f) => <span className="text-xs text-muted">{f.domain}</span> },
                  { key: 'status', header: 'Status', render: (f) => <Badge>{f.status.replace(/_/g, ' ')}</Badge> },
                ]}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="inline-block h-2 w-2 rounded-full bg-current opacity-60" />;
}
