'use client';
import React from 'react';
import { channelsApi, type Channel } from '@/lib/api';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Badge, Select, Input, Field } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function ChannelsPage() {
  const { can, me } = useAuth();
  const [rows, setRows] = React.useState<Channel[] | null>(null);
  const load = React.useCallback(() => { setRows(null); channelsApi.list().then(setRows).catch(() => setRows([])); }, []);
  React.useEffect(() => { load(); }, [load]);
  const canManage = can('channel.manage');
  const [creating, setCreating] = React.useState(false);
  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const isAgent = me?.plane === 'nexus';
  React.useEffect(() => { if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {}); }, [isAgent]);
  async function toggle(c: Channel) { await channelsApi.update(c.id, { enabled: !c.enabled }); load(); }
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Channels</h1><p className="mt-1 text-sm text-muted">Configured intake channels.</p></div>
        {canManage && <Button onClick={() => setCreating(true)}>New channel</Button>}
      </div>
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
      {creating && (
        <NewChannelModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
      )}
    </div>
  );
}

function NewChannelModal({ orgs, isAgent, onClose, onCreated }: { orgs: { id: string; name: string }[]; isAgent: boolean; onClose: () => void; onCreated: () => void }) {
  const [type, setType] = React.useState<'email' | 'portal' | 'widget'>('email');
  const [name, setName] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [err, setErr] = React.useState('');
  async function save() {
    try {
      await channelsApi.create({ type, name, ...(isAgent ? { organizationId } : {}) });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Dialog title="New channel" onClose={onClose} size="md">
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as 'email' | 'portal' | 'widget')}><option value="email">Email</option><option value="portal">Portal</option><option value="widget">Widget</option></Select></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="support@acme" /></Field>
          {isAgent && <Field label="Organization"><Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>}
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name || (isAgent && !organizationId)}>Create</Button></div>
    </Dialog>
  );
}
