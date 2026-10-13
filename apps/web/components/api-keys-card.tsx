'use client';
// Machine-to-machine API keys for one organization (ADR-0013). Minting one previously required
// a shell, a session token lifted out of the browser, and curl — so the credential every
// integration needs was gated behind the most error-prone path available.
//
// The one rule this component exists to honour: the secret is returned exactly once, by the
// create call, and is never readable again. So it lives in local state only, is never written
// into the list, and is dropped on dismissal. An empty box is the honest depiction of a value
// nobody can read — including us.
import React from 'react';
import { apiKeysApi, ApiError, type ApiKey, type CreatedApiKey } from '@/lib/api';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Field, Badge } from '@/components/ui/primitives';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function ApiKeysCard({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const [keys, setKeys] = React.useState<ApiKey[] | null>(null);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The plaintext token, held ONLY between creation and dismissal.
  const [revealed, setRevealed] = React.useState<CreatedApiKey | null>(null);

  const refresh = React.useCallback(() => {
    if (!organizationId) return;
    apiKeysApi.list(organizationId).then(setKeys).catch(() => setKeys([]));
  }, [organizationId]);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function create() {
    const trimmed = name.trim();
    // Guard here rather than relying on the API's 422: a round trip to be told the box is
    // empty is a worse answer than not sending it.
    if (trimmed.length < 2) {
      setError('Give the key a name so it can be told apart when it needs revoking.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await apiKeysApi.create({ organizationId, name: trimmed });
      setRevealed(created);
      setName('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await apiKeysApi.revoke(id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not revoke the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Machine-to-machine credentials for integrations that sync tickets into this
          organization. A key is scoped to this organization alone — it cannot reach another.
        </p>

        {revealed && (
          <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
            <div className="text-sm font-medium">
              Copy this now — it is the only time the secret is shown.
            </div>
            <code className="block break-all rounded bg-background px-2 py-1 text-xs">{revealed.token}</code>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(revealed.token); }}
              >
                Copy
              </Button>
              <Button type="button" variant="outline" onClick={() => setRevealed(null)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {error && <div role="alert" className="text-sm text-destructive">{error}</div>}

        {canManage && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Key name" hint="What will use it, e.g. “Carbon ConMon sync”.">
                <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              </Field>
            </div>
            <Button type="button" onClick={create} disabled={busy}>Create key</Button>
          </div>
        )}

        {keys === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="text-sm text-muted-foreground">No keys yet.</div>
        ) : (
          <ul className="divide-y">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{k.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <code>ak_{k.key_id}_…</code> · created {fmt(k.created_at)} · last used {fmt(k.last_used_at)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {k.revoked_at ? (
                    <Badge>revoked</Badge>
                  ) : (
                    canManage && (
                      <Button type="button" variant="outline" onClick={() => revoke(k.id)} disabled={busy}>
                        Revoke
                      </Button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
