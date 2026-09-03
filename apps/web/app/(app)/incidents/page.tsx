'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

export default function IncidentsPage() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?type=incident&limit=200').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);
  const open = (rows ?? []).filter((t) => t.status !== 'closed' && t.status !== 'resolved').length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
        <p className="mt-1 text-sm text-muted">Tickets of type incident.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Open incidents" value={rows === null ? '—' : open} />
        <StatCard label="Total" value={rows === null ? '—' : rows.length} />
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Ticket>
            rows={rows}
            columns={[
              { key: 'ticket_number', header: 'Incident', render: (t) => <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> },
              { key: 'subject', header: 'Subject', render: (t) => t.subject },
              { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
              { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]}
            empty={<EmptyState title="No incidents" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
