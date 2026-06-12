'use client';
import * as React from 'react';
import { api } from '@/lib/api';
import { Card, CardBody, CardTitle, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_plane: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
}

export default function AuditPage() {
  const [rows, setRows] = React.useState<AuditRow[] | null>(null);

  React.useEffect(() => {
    api.get<{ data: AuditRow[] }>('/audit-logs?limit=200').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted">Immutable, hash-chained record of privileged and sensitive actions.</p>
      </div>
      <Card>
        <div className="flex items-center justify-between border-b border-border p-4">
          <CardTitle>Recent activity</CardTitle>
          <Badge tone="success">tamper-evident</Badge>
        </div>
        <CardBody className="px-0 pt-0">
          {!rows ? (
            <div className="space-y-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : (
            <DataTable<AuditRow>
              rows={rows}
              empty={<EmptyState title="No audit entries yet" description="Privileged actions will appear here." />}
              columns={[
                { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-xs text-fg">{r.action}</span> },
                { key: 'resource', header: 'Resource', render: (r) => <span className="text-xs text-muted">{r.resource_type ?? '—'}</span> },
                { key: 'plane', header: 'Plane', render: (r) => <Badge tone={r.actor_plane === 'nexus' ? 'brand' : 'neutral'}>{r.actor_plane ?? 'system'}</Badge> },
                { key: 'time', header: 'When', render: (r) => <span className="text-xs text-muted">{new Date(r.created_at).toLocaleString()}</span> },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
