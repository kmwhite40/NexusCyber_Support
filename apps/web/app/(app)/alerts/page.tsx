'use client';
import React from 'react';
import { alertsApi, type Alert } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

export default function AlertsPage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Alert[] | null>(null);
  const [state, setState] = React.useState('');
  const load = React.useCallback(() => { setRows(null); alertsApi.list(state ? `?state=${state}` : '').then(setRows).catch(() => setRows([])); }, [state]);
  React.useEffect(() => { load(); }, [load]);
  const canAck = can('alert.ack');
  const canManage = can('alert.manage');
  async function act(p: Promise<unknown>) { await p; load(); }
  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-semibold tracking-tight">Alerts</h1><p className="mt-1 text-sm text-muted">Operational alert feed.</p></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Triggered" value={rows === null ? '—' : rows.filter((a) => a.state === 'triggered').length} />
        <StatCard label="Acknowledged" value={rows === null ? '—' : rows.filter((a) => a.state === 'acknowledged').length} />
        <StatCard label="Shown" value={rows === null ? '—' : rows.length} />
      </div>
      <div className="flex gap-3">
        <Select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option><option value="triggered">Triggered</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option>
        </Select>
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Alert>
            rows={rows}
            columns={[
              { key: 'severity', header: 'Sev', render: (a) => a.severity },
              { key: 'summary', header: 'Summary', render: (a) => a.summary },
              { key: 'source', header: 'Source', render: (a) => a.source },
              { key: 'state', header: 'State', render: (a) => a.state },
              { key: 'actions', header: '', render: (a) => (
                <div className="flex gap-2">
                  {canAck && a.state === 'triggered' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.ack(a.id))}>Ack</Button>}
                  {canAck && a.state !== 'resolved' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.resolve(a.id))}>Resolve</Button>}
                  {canManage && a.state !== 'resolved' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.escalate(a.id, { toPage: true, toTicket: true }))}>Escalate</Button>}
                </div>
              ) },
            ]}
            empty={<EmptyState title="No alerts" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
