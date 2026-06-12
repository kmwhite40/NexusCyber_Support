'use client';
import * as React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardBody, CardTitle, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

interface Queue { id: string; name: string; order_by: string; definition: Record<string, unknown> }
interface QTicket {
  id: string; ticket_number: string; subject: string; status: string; priority: string;
  assigned_agent_id: string | null; next_sla_due: string | null;
}

function dueLabel(due: string | null): { text: string; tone: 'danger' | 'warning' | 'neutral' } {
  if (!due) return { text: 'no SLA', tone: 'neutral' };
  const ms = new Date(due).getTime() - Date.now();
  if (ms < 0) return { text: 'breached', tone: 'danger' };
  const hours = Math.round(ms / 3600000);
  return { text: hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`, tone: hours < 4 ? 'warning' : 'neutral' };
}

export default function QueuesPage() {
  const [queues, setQueues] = React.useState<Queue[] | null>(null);
  const [active, setActive] = React.useState<string | null>(null);
  const [tickets, setTickets] = React.useState<QTicket[] | null>(null);

  React.useEffect(() => {
    api.get<{ data: Queue[] }>('/queues').then((r) => { setQueues(r.data); if (r.data[0]) setActive(r.data[0].id); }).catch(() => setQueues([]));
  }, []);

  React.useEffect(() => {
    if (!active) return;
    setTickets(null);
    api.get<{ queue: Queue; tickets: QTicket[] }>(`/queues/${active}/tickets`).then((r) => setTickets(r.tickets)).catch(() => setTickets([]));
  }, [active]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Work queues</h1>
        <p className="mt-1 text-sm text-muted">Saved ticket filters sorted by the soonest-breaching SLA.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <Card>
          <CardBody className="space-y-1">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Queues</div>
            {!queues ? <Skeleton className="h-8" /> : queues.map((q) => (
              <button key={q.id} onClick={() => setActive(q.id)} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-surface-2 ${active === q.id ? 'bg-brand/10 text-brand' : 'text-fg/90'}`}>
                <span className="truncate">{q.name}</span>
                <Badge tone="neutral" className="text-[9px]">{q.order_by}</Badge>
              </button>
            ))}
          </CardBody>
        </Card>

        <Card>
          <div className="border-b border-border p-4"><CardTitle>{queues?.find((q) => q.id === active)?.name ?? 'Tickets'}</CardTitle></div>
          <CardBody className="px-0 pt-0">
            {!tickets ? (
              <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              <DataTable<QTicket>
                rows={tickets}
                empty={<EmptyState title="Queue is empty" description="No tickets match this queue right now." />}
                columns={[
                  { key: 'num', header: 'Ticket', render: (t) => <Link href={`/tickets/${t.id}`} className="font-mono text-xs text-brand hover:underline">{t.ticket_number}</Link> },
                  { key: 'subject', header: 'Subject', render: (t) => <span className="text-sm text-fg">{t.subject}</span> },
                  { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
                  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
                  { key: 'sla', header: 'SLA due', render: (t) => { const d = dueLabel(t.next_sla_due); return <Badge tone={d.tone}>{d.text}</Badge>; } },
                ]}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
