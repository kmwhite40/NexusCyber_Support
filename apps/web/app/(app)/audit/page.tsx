'use client';
import * as React from 'react';
import { api, getToken } from '@/lib/api';
import { Card, CardBody, CardTitle, Badge, Button } from '@/components/ui/primitives';
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';

export default function AuditPage() {
  const [rows, setRows] = React.useState<AuditRow[] | null>(null);
  const [verify, setVerify] = React.useState<{ ok: boolean; checked: number; brokenAt: number | null } | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.get<{ data: AuditRow[] }>('/audit-logs?limit=200').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);

  async function runVerify() {
    setBusy(true);
    try {
      const v = await api.get<{ ok: boolean; checked: number; brokenAt: number | null }>('/audit/verify');
      setVerify(v);
    } finally {
      setBusy(false);
    }
  }

  async function exportAudit(format: 'ndjson' | 'cef') {
    const token = getToken();
    const res = await fetch(`${API_BASE}/audit/export?format=${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-audit.${format === 'cef' ? 'cef' : 'ndjson'}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-muted">Immutable, hash-chained record of privileged and sensitive actions.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={runVerify} disabled={busy}>{busy ? 'Verifying…' : 'Verify chain'}</Button>
          <Button size="sm" variant="ghost" onClick={() => exportAudit('ndjson')}>Export NDJSON</Button>
          <Button size="sm" variant="ghost" onClick={() => exportAudit('cef')}>Export CEF (SIEM)</Button>
        </div>
      </div>

      {verify && (
        <Card className={verify.ok ? 'border-success/40' : 'border-danger/40'}>
          <CardBody className="flex items-center gap-3 py-3.5">
            <Badge tone={verify.ok ? 'success' : 'danger'}>{verify.ok ? 'chain intact' : 'TAMPERING DETECTED'}</Badge>
            <span className="text-sm text-muted">
              {verify.ok
                ? `Verified ${verify.checked} entries — hash chain is consistent.`
                : `Divergence at entry #${verify.brokenAt} of ${verify.checked} checked.`}
            </span>
          </CardBody>
        </Card>
      )}

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
