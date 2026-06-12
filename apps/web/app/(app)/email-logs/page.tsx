'use client';
import React from 'react';
import { emailLogApi, type Delivery } from '@/lib/api';
import { Card, CardBody, Select, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function EmailLogsPage() {
  const [rows, setRows] = React.useState<Delivery[] | null>(null);
  const [channel, setChannel] = React.useState('');
  const [status, setStatus] = React.useState('');

  React.useEffect(() => {
    const params = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (status) params.set('status', status);
    const q = params.toString();
    setRows(null);
    emailLogApi.list(q ? `?${q}` : '').then(setRows).catch(() => setRows([]));
  }, [channel, status]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email &amp; notification logs</h1>
        <p className="mt-1 text-sm text-muted">Delivery history across channels.</p>
      </div>
      <div className="flex gap-3">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="email">Email</option>
          <option value="teams">Teams</option>
          <option value="portal">Portal</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
          <option value="substituted">Substituted</option>
        </Select>
      </div>
      <Card>
        <CardBody>
          {rows === null ? (
            <Skeleton className="h-12" />
          ) : (
            <DataTable<Delivery>
              rows={rows}
              columns={[
                { key: 'created_at', header: 'Time', render: (d) => new Date(d.created_at).toLocaleString() },
                { key: 'event_type', header: 'Event', render: (d) => d.event_type },
                { key: 'channel', header: 'Channel', render: (d) => <Badge>{d.channel}</Badge> },
                { key: 'recipient', header: 'Recipient', render: (d) => d.recipient },
                { key: 'status', header: 'Status', render: (d) => d.status },
              ]}
              empty={<EmptyState title="No deliveries logged" />}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
