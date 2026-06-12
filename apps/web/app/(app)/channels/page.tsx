'use client';
import React from 'react';
import { channelsApi, type Channel } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function ChannelsPage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Channel[] | null>(null);
  const load = React.useCallback(() => { setRows(null); channelsApi.list().then(setRows).catch(() => setRows([])); }, []);
  React.useEffect(() => { load(); }, [load]);
  const canManage = can('channel.manage');
  async function toggle(c: Channel) { await channelsApi.update(c.id, { enabled: !c.enabled }); load(); }
  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-semibold tracking-tight">Channels</h1><p className="mt-1 text-sm text-muted">Configured intake channels.</p></div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Channel>
            rows={rows}
            columns={[
              { key: 'name', header: 'Name', render: (c) => c.name },
              { key: 'type', header: 'Type', render: (c) => <Badge>{c.type}</Badge> },
              { key: 'enabled', header: 'Enabled', render: (c) => c.enabled ? 'Yes' : 'No' },
              { key: 'actions', header: '', render: (c) => canManage ? <Button size="sm" variant="outline" onClick={() => toggle(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button> : null },
            ]}
            empty={<EmptyState title="No channels configured" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
