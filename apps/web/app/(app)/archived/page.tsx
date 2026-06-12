'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

export default function ArchivedPage() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?status=closed&limit=200').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Archived work items</h1>
        <p className="mt-1 text-sm text-muted">Closed tickets. Archived knowledge-base pages are managed from the <Link className="text-brand hover:underline" href="/kb">knowledge base</Link>.</p>
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Ticket>
            rows={rows}
            columns={[
              { key: 'ticket_number', header: 'Ticket', render: (t) => <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> },
              { key: 'subject', header: 'Subject', render: (t) => t.subject },
              { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
              { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]}
            empty={<EmptyState title="No archived items" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
