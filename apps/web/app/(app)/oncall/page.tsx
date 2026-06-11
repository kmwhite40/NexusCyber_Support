'use client';
// On-call console (docs/nexus/04-sla-oncall.md §H) — current responder, rotation,
// and active pages with acknowledge / escalate.
import * as React from 'react';
import { oncall, type OnCallSchedule, type OnCallPage } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

export default function OnCallPage() {
  const { can } = useAuth();
  const [schedules, setSchedules] = React.useState<OnCallSchedule[] | null>(null);
  const [pages, setPages] = React.useState<OnCallPage[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    oncall.schedules().then((r) => setSchedules(r.data)).catch(() => setSchedules([]));
    oncall.pages().then((r) => setPages(r.data)).catch(() => setPages([]));
  }, []);
  React.useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      load();
    } finally {
      setBusy(false);
    }
  }

  const open = (pages ?? []).filter((p) => p.state === 'notified' || p.state === 'escalated');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">On-call console</h1>
          <p className="mt-1 text-sm text-muted">Current responders, rotations, and active pages.</p>
        </div>
        {can('oncall.page') && (
          <Button onClick={() => act(() => oncall.createPage({ severity: 'Sev2' }))} disabled={busy}>
            Trigger test page
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Open pages" value={pages ? open.length : '—'} tone="danger" />
        <StatCard label="Schedules" value={schedules ? schedules.length : '—'} tone="brand" />
        <StatCard
          label="On call now"
          value={schedules?.[0]?.current?.name?.split(' ')[0] ?? '—'}
          tone="accent"
        />
      </div>

      {/* Schedules */}
      <div className="grid gap-6 lg:grid-cols-2">
        {!schedules ? (
          <Skeleton className="h-48" />
        ) : (
          schedules.map((s) => (
            <Card key={s.id}>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>{s.team}</CardTitle>
                <Badge tone="neutral">{s.coverage}</Badge>
              </CardHeader>
              <CardBody>
                <div className="mb-4 flex items-center gap-3 rounded-md border border-brand/30 bg-brand/10 px-4 py-3">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-brand-fg">
                    {(s.current?.name ?? '?').slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-fg">{s.current?.name ?? 'Unassigned'}</div>
                    <div className="text-[11px] text-muted">On call now {s.current?.via === 'override' ? '(override)' : `· ${s.rotationLengthDays}-day rotation`}</div>
                  </div>
                </div>
                <div className="text-xs font-medium text-muted">Rotation</div>
                <ol className="mt-2 space-y-1">
                  {s.participants.map((p) => (
                    <li key={p.position} className="flex items-center gap-2 text-xs">
                      <span className="grid h-5 w-5 place-items-center rounded-full border border-border text-[10px] text-muted">{p.position + 1}</span>
                      <span className={s.current?.name === p.name ? 'font-medium text-brand' : 'text-fg'}>{p.name}</span>
                      {s.current?.name === p.name && <Badge tone="brand">current</Badge>}
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      {/* Pages */}
      <Card>
        <CardHeader><CardTitle>Pages</CardTitle></CardHeader>
        <CardBody className="px-0 pt-0">
          {!pages ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<OnCallPage>
              rows={pages}
              empty={<EmptyState title="No pages" description="Active and recent pages will appear here." />}
              columns={[
                { key: 'sev', header: 'Severity', render: (p) => <Badge tone={p.severity === 'Sev1' ? 'danger' : 'warning'}>{p.severity}</Badge> },
                { key: 'responder', header: 'Responder', render: (p) => <span className="text-fg">{p.responder ?? '—'}</span> },
                { key: 'org', header: 'Customer', render: (p) => <span className="text-xs text-muted">{p.org ?? '—'}</span> },
                {
                  key: 'state', header: 'State', render: (p) => (
                    <Badge tone={p.state === 'acknowledged' ? 'success' : p.state === 'escalated' ? 'danger' : p.state === 'resolved' ? 'neutral' : 'warning'}>
                      {p.state}
                    </Badge>
                  ),
                },
                { key: 'when', header: 'Created', render: (p) => <span className="text-xs text-muted">{new Date(p.created_at).toLocaleString()}</span> },
                {
                  key: 'act', header: '', render: (p) =>
                    p.state === 'notified' || p.state === 'escalated' ? (
                      <div className="flex gap-2">
                        {can('oncall.acknowledge') && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => oncall.ack(p.id))}>Ack</Button>}
                        {can('oncall.page') && <Button size="sm" variant="subtle" disabled={busy} onClick={() => act(() => oncall.escalatePage(p.id))}>Escalate</Button>}
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
