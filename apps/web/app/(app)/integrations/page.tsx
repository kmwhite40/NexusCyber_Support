'use client';
// Per-customer Entra/Intune device sync — credentials, connection test, and manual sync.
//
// Two things this page must never do: show a stored client secret (the API does not return one,
// and nothing here caches what was typed), and imply a sync succeeded when it was skipped.
import React from 'react';
import {
  entraApi, customersApi, ApiError,
  type OrgSummary, type EntraIntegration, type EntraSyncRun, type EntraSyncStats,
} from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Field, Select, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

const CONSENT_HELP =
  'In the customer’s Entra tenant, create an app registration and grant admin consent for the '
  + 'application permission DeviceManagementManagedDevices.Read.All.';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export default function IntegrationsPage() {
  const { can } = useAuth();
  const canManage = can('integration.credentials.manage');

  const [orgs, setOrgs] = React.useState<OrgSummary[]>([]);
  const [orgId, setOrgId] = React.useState('');
  const [integration, setIntegration] = React.useState<EntraIntegration | null>(null);
  const [runs, setRuns] = React.useState<EntraSyncRun[] | null>(null);
  const [tenantId, setTenantId] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  React.useEffect(() => {
    customersApi.list().then((o) => { setOrgs(o); setOrgId((cur) => cur || o[0]?.id || ''); }).catch(() => setOrgs([]));
  }, []);

  const refresh = React.useCallback((id: string) => {
    if (!id) return;
    setRuns(null);
    entraApi.status(id)
      .then((r) => {
        setIntegration(r.integration);
        setRuns(r.runs);
        // Prefill the identifiers so an edit does not require retyping them. The secret is
        // deliberately blanked: an empty box is the honest depiction of a value we cannot read.
        setTenantId(r.integration?.tenant_id ?? '');
        setClientId(r.integration?.client_id ?? '');
        setClientSecret('');
      })
      .catch(() => { setIntegration(null); setRuns([]); });
  }, []);

  React.useEffect(() => { refresh(orgId); }, [orgId, refresh]);

  if (!canManage) {
    return <EmptyState title="Access denied" description="You need the integration-credentials permission to view this page." />;
  }

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
      refresh(orgId);
    }
  };

  const save = () => run('save', async () => {
    if (!clientSecret) throw new Error('Client secret is required (it is never read back, so re-enter it to save).');
    await entraApi.configure({ organizationId: orgId, tenantId, clientId, clientSecret });
    setClientSecret('');
    setMsg({ tone: 'ok', text: 'Credentials saved. Sync stays disabled until you test the connection.' });
  });

  const test = () => run('test', async () => {
    const r = await entraApi.test(orgId);
    setMsg(r.ok
      ? { tone: 'ok', text: 'Connection OK.' }
      : { tone: 'bad', text: `Connection failed: ${r.error ?? 'unknown error'}` });
  });

  const toggle = (enabled: boolean) => run('toggle', async () => {
    await entraApi.setEnabled(orgId, enabled);
    setMsg({ tone: 'ok', text: enabled ? 'Scheduled sync enabled.' : 'Scheduled sync disabled.' });
  });

  const syncNow = () => run('sync', async () => {
    const s: EntraSyncStats = await entraApi.sync(orgId);
    // A skipped retirement is the whole point of the guard — reporting it as a clean sync would
    // hide exactly the situation an admin needs to look at.
    setMsg(s.skippedRetirement
      ? { tone: 'bad', text: `Synced ${s.created} new / ${s.updated} updated, but retirement was skipped: ${s.skipReason ?? 'the enumeration looked incomplete'}. Nothing was retired — check the app registration's permissions and scope before assuming those devices are really gone.` }
      : { tone: 'ok', text: `Sync complete: ${s.created} created, ${s.updated} updated, ${s.retired} retired.` });
  });

  const statusTone = integration?.status === 'ok' ? 'success' : integration?.status === 'error' ? 'danger' : 'neutral';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted">
          Populate the CMDB with a customer&apos;s Entra/Intune managed devices. {CONSENT_HELP}
        </p>
      </div>

      <Card><CardBody>
        <Field label="Customer">
          <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
      </CardBody></Card>

      {msg && <p className={`text-sm ${msg.tone === 'ok' ? 'text-success' : 'text-danger'}`}>{msg.text}</p>}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Entra / Intune device sync</CardTitle>
          <div className="flex items-center gap-2">
            <Badge tone={statusTone}>{integration?.status ?? 'not configured'}</Badge>
            <Badge tone={integration?.enabled ? 'success' : 'neutral'}>
              {integration?.enabled ? 'scheduled sync on' : 'scheduled sync off'}
            </Badge>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Directory (tenant) ID">
              <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
            <Field label="Application (client) ID">
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
            <Field label="Client secret" hint="Write-only. Stored encrypted and never shown again.">
              <Input type="password" autoComplete="new-password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={integration ? 'unchanged unless you type a new one' : ''} />
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={!orgId || !tenantId || !clientId || busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save credentials'}
            </Button>
            <Button variant="outline" onClick={test} disabled={!integration || busy !== null}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </Button>
            <Button variant="outline" onClick={() => toggle(!integration?.enabled)} disabled={!integration || busy !== null}>
              {integration?.enabled ? 'Disable scheduled sync' : 'Enable scheduled sync'}
            </Button>
            <Button variant="outline" onClick={syncNow} disabled={!integration?.enabled || busy !== null}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>

          {integration && (
            <div className="text-sm text-muted">
              Last sync {fmt(integration.last_sync_at)}
              {integration.last_error && <span className="text-danger"> — {integration.last_error}</span>}
            </div>
          )}
          {integration && !integration.enabled && (
            <p className="text-xs text-muted">
              Sync now requires scheduled sync to be enabled — both read the same flag, so a manual run
              cannot quietly use credentials the org has switched off.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent sync runs</CardTitle></CardHeader>
        <CardBody>
          {runs === null ? <Skeleton className="h-12" /> : (
            <DataTable<EntraSyncRun>
              rows={runs}
              columns={[
                { key: 'started_at', header: 'Started', render: (r) => fmt(r.started_at) },
                { key: 'status', header: 'Result', render: (r) => <Badge tone={r.status === 'ok' ? 'success' : 'danger'}>{r.status}</Badge> },
                { key: 'created_count', header: 'Created', render: (r) => r.created_count },
                { key: 'updated_count', header: 'Updated', render: (r) => r.updated_count },
                { key: 'retired_count', header: 'Retired', render: (r) => r.retired_count },
                { key: 'error', header: 'Error', render: (r) => r.error ? <span className="text-danger">{r.error}</span> : <span className="text-muted">—</span> },
              ]}
              empty={<EmptyState title="No sync runs yet" description="Save credentials, test the connection, then run a sync." />}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
