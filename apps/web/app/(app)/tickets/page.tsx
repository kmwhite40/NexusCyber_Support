'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody, Button, Input, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

const STATUSES = ['', 'new', 'triage', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed'];

export default function TicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = React.useState<Ticket[] | null>(null);
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');

  const load = React.useCallback(() => {
    setTickets(null);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    qs.set('limit', '100');
    api.get<{ data: Ticket[] }>(`/tickets?${qs}`).then((r) => setTickets(r.data)).catch(() => setTickets([]));
  }, [status]);

  React.useEffect(load, [load]);

  const filtered = (tickets ?? []).filter(
    (t) => !q || t.subject.toLowerCase().includes(q.toLowerCase()) || t.ticket_number.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
        <Button onClick={() => router.push('/tickets/new')}>+ New ticket</Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <Input className="max-w-xs" placeholder="Search subject or #…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'All statuses'}</option>)}
          </Select>
          <span className="ml-auto text-xs text-muted">{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
        </div>
        <CardBody className="px-0 pt-0">
          {!tickets ? (
            <div className="space-y-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<Ticket>
              rows={filtered}
              onRowClick={(t) => router.push(`/tickets/${t.id}`)}
              empty={<EmptyState title="No tickets match" description="Try clearing filters or create a new ticket." action={<Button size="sm" onClick={() => router.push('/tickets/new')}>New ticket</Button>} />}
              columns={[
                { key: 'num', header: 'Ticket', render: (t) => <span className="font-mono text-xs text-muted">{t.ticket_number}</span> },
                { key: 'subject', header: 'Subject', render: (t) => <span className="font-medium text-fg">{t.subject}</span> },
                { key: 'type', header: 'Type', render: (t) => <span className="text-xs text-muted">{t.type.replace(/_/g, ' ')}</span> },
                { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
                { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
                { key: 'created', header: 'Created', render: (t) => <span className="text-xs text-muted">{new Date(t.created_at).toLocaleDateString()}</span> },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
