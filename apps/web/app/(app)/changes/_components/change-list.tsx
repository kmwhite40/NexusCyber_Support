'use client';
// The changes table. Extracted from the changes page; behaviour unchanged.
import * as React from 'react';
import { Card, CardHeader, CardTitle, CardBody, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { statusTone, riskTone, type Change } from '@/lib/changes';

export function ChangeList({
  rows,
  onOpen,
}: {
  /** null while the first load is in flight. */
  rows: Change[] | null;
  onOpen: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Changes</CardTitle></CardHeader>
      <CardBody className="px-0 pt-0">
        {!rows ? (
          <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <DataTable<Change>
            rows={rows}
            onRowClick={(c) => onOpen(c.id)}
            empty={<EmptyState title="No changes" description="Create a change to begin the CAB workflow." />}
            columns={[
              { key: 'title', header: 'Change', render: (c) => <span className="font-medium text-fg">{c.title}</span> },
              { key: 'type', header: 'Type', render: (c) => <Badge tone="neutral">{c.change_type}</Badge> },
              { key: 'risk', header: 'Risk', render: (c) => <Badge tone={riskTone(c.risk)}>{c.risk}</Badge> },
              { key: 'status', header: 'Status', render: (c) => <Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, ' ')}</Badge> },
              { key: 'window', header: 'Window', render: (c) => <span className="text-xs text-muted">{c.window_start ? new Date(c.window_start).toLocaleString() : '—'}</span> },
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}
