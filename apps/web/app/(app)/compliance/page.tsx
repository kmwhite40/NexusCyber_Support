'use client';
import * as React from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

interface Coverage {
  id: string; // = control_id (DataTable requires an `id` key)
  control_id: string;
  framework: string;
  family: string;
  title: string;
  mapped: number;
  satisfied: number;
  status: 'satisfied' | 'partial' | 'gap';
}

const tone = (s: Coverage['status']) => (s === 'satisfied' ? 'success' : s === 'partial' ? 'warning' : 'danger');

export default function CompliancePage() {
  const { me, can } = useAuth();
  const isAgent = me?.plane === 'nexus';
  const [rows, setRows] = React.useState<Coverage[] | null>(null);
  const [exporting, setExporting] = React.useState(false);

  // Coverage is per-tenant: nexus operators pick a customer; a customer's own org is implicit.
  const [orgId, setOrgId] = React.useState('');
  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {});
  }, [isAgent]);
  const needsOrg = isAgent && !orgId;
  const org = isAgent ? orgId || undefined : undefined;
  const orgQs = org ? `?organizationId=${org}` : '';

  React.useEffect(() => {
    if (needsOrg) { setRows(null); return; }
    setRows(null);
    api
      .get<{ data: Coverage[] }>(`/compliance/coverage${orgQs}`)
      .then((r) => setRows(r.data.map((c) => ({ ...c, id: c.control_id }))))
      .catch(() => setRows([]));
  }, [needsOrg, orgQs]);

  async function exportPackage() {
    setExporting(true);
    try {
      const pkg = await api.post<unknown>(`/compliance/evidence-package${orgQs}`);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nexus-evidence-package.json';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const counts = (rows ?? []).reduce<Record<string, number>>((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compliance</h1>
          <p className="mt-1 text-sm text-muted">Control coverage computed from posture, continuous monitoring, and the audit trail.</p>
        </div>
        <div className="flex items-center gap-3">
          {isAgent && (
            <Select className="h-9 w-56" value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Customer">
              <option value="">Select customer…</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          )}
          {can('compliance.read') && !needsOrg && (
            <Button variant="outline" onClick={exportPackage} disabled={exporting}>
              {exporting ? 'Exporting…' : 'Export evidence package'}
            </Button>
          )}
        </div>
      </div>

      {needsOrg ? (
        <Card>
          <CardBody>
            <EmptyState title="Select a customer" description="Choose an organization above to view its control coverage and export an evidence package." />
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Satisfied" value={counts.satisfied ?? 0} tone="success" />
            <StatCard label="Partial" value={counts.partial ?? 0} tone="warning" />
            <StatCard label="Gaps" value={counts.gap ?? 0} tone="danger" />
          </div>

          <Card>
            <CardHeader><CardTitle>Controls</CardTitle></CardHeader>
            <CardBody className="px-0 pt-0">
              {!rows ? (
                <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : (
                <DataTable<Coverage>
                  rows={rows}
                  empty={<EmptyState title="No controls" description="No compliance controls are configured." />}
                  columns={[
                    { key: 'id', header: 'Control', render: (c) => <span className="font-medium text-fg">{c.control_id}</span> },
                    { key: 'framework', header: 'Framework', render: (c) => <span className="text-xs text-muted">{c.framework}</span> },
                    { key: 'title', header: 'Title', render: (c) => <span className="text-sm text-fg">{c.title}</span> },
                    { key: 'evidence', header: 'Evidence', render: (c) => <span className="tabular-nums text-xs text-muted">{c.satisfied}/{c.mapped}</span> },
                    { key: 'status', header: 'Status', render: (c) => <Badge tone={tone(c.status)}>{c.status}</Badge> },
                  ]}
                />
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
