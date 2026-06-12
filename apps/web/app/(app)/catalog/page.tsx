'use client';
// Service catalog — the in-scope helpdesk request types as guided, workflow-backed
// requests (docs/nexus/workflows/service-desk-workflows.md).
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api, catalog, users, attachmentsApi, type CatalogItem, type Ticket, type CatalogForm, type FormFieldDef, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { UserPicker } from '@/components/user-picker';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input, Textarea, Field, Select } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';

export default function CatalogPage() {
  const router = useRouter();
  const { me } = useAuth();
  const [items, setItems] = React.useState<CatalogItem[] | null>(null);
  const [active, setActive] = React.useState<CatalogItem | null>(null);
  const [orgs, setOrgs] = React.useState<Array<{ id: string; name: string }>>([]);

  React.useEffect(() => {
    catalog.list().then((r) => setItems(r.data)).catch(() => setItems([]));
    if (me?.plane === 'nexus') {
      api.get<{ data: Array<{ id: string; name: string }> }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {});
    }
  }, [me]);

  const grouped = (items ?? []).reduce<Record<string, CatalogItem[]>>((acc, it) => {
    (acc[it.category] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Service catalog</h1>
        <p className="mt-1 text-sm text-muted">
          Request a standard service. Each item routes to the right tier, applies an SLA, and runs a
          defined fulfillment workflow with approvals where required.
        </p>
      </div>

      {!items ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : (
        Object.entries(grouped).map(([category, list]) => (
          <div key={category}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{category}</h2>
              <span className="text-xs text-muted">({list.length})</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((it) => (
                <Card key={it.key} className="flex h-full flex-col transition-transform hover:-translate-y-1">
                  <CardBody className="flex flex-1 flex-col">
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-fg">{it.name}</h3>
                      {it.requires_approval && <Badge tone="warning">approval</Badge>}
                      {it.security_class !== 'standard' && <Badge tone="danger">{it.security_class}</Badge>}
                    </div>
                    <p className="flex-1 text-xs leading-relaxed text-muted">
                      Owned by <span className="text-fg">{it.owning_tier}</span>. Resolution SLA{' '}
                      {Math.round(it.sla_resolution_min / 60)}h. {it.fulfillment_steps.length} fulfillment steps.
                    </p>
                    <div className="mt-3 flex items-center justify-between">
                      <Badge tone={it.default_priority === 'P1' ? 'danger' : it.default_priority === 'P2' ? 'warning' : 'brand'}>
                        {it.default_priority}
                      </Badge>
                      <Button size="sm" onClick={() => setActive(it)}>Request</Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}

      {active && (
        <RequestModal
          item={active}
          orgs={orgs}
          isAgent={me?.plane === 'nexus'}
          onClose={() => setActive(null)}
          onCreated={(t) => router.push(`/tickets/${t.id}`)}
        />
      )}
    </div>
  );
}

function RequestModal({
  item, orgs, isAgent, onClose, onCreated,
}: {
  item: CatalogItem;
  orgs: Array<{ id: string; name: string }>;
  isAgent: boolean;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const { me } = useAuth();
  const [form, setForm] = React.useState<CatalogForm | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [orgId, setOrgId] = React.useState(orgs[0]?.id ?? '');
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});
  const [file, setFile] = React.useState<File | null>(null);
  const [subject, setSubject] = React.useState(item.name);
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    catalog.form(item.key).then((r) => setForm(r.form)).catch(() => setForm(null)).finally(() => setLoaded(true));
  }, [item.key]);

  const searchOrg = isAgent ? orgId : me?.organization_id ?? undefined;
  const set = (key: string, v: unknown) => setAnswers((a) => ({ ...a, [key]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = form
        ? { organizationId: isAgent ? orgId : undefined, answers }
        : { subject, description, organizationId: isAgent ? orgId : undefined };
      const t = await catalog.request(item.key, body);
      if (file) await attachmentsApi.upload(t.id, file);
      onCreated(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not submit request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader><CardTitle>{item.name}</CardTitle></CardHeader>
        <CardBody>
          {form && <p className="mb-4 text-xs text-muted">Required fields are marked with an asterisk<span className="text-danger">*</span></p>}
          <form onSubmit={submit}>
            {isAgent && (
              <Field label="Customer organization">
                <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            )}

            {!loaded && <p className="text-xs text-muted">Loading…</p>}

            {loaded && form && form.fields.map((f: FormFieldDef) => (
              <Field key={f.key} label={f.required ? `${f.label} *` : f.label}>
                {f.data_type === 'textarea' ? (
                  <Textarea value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                ) : f.data_type === 'select' ? (
                  <Select value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="" disabled>Select…</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : f.data_type === 'checkbox' ? (
                  <input type="checkbox" checked={!!answers[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
                ) : f.data_type === 'user' ? (
                  <UserPicker value={(answers[f.key] as string) ?? null} onChange={(v) => set(f.key, v)} organizationId={searchOrg} />
                ) : f.data_type === 'user_multi' ? (
                  <UserPicker value={(answers[f.key] as string[]) ?? []} onChange={(v) => set(f.key, v)} organizationId={searchOrg} multiple />
                ) : f.data_type === 'attachment' ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted">
                    <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    {file && <span className="ml-2 text-fg">{file.name}</span>}
                  </div>
                ) : (
                  <Input
                    value={(answers[f.key] as string) ?? ''}
                    placeholder={f.key === 'summary' ? 'e.g. Create an account on Jira' : undefined}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </Field>
            ))}

            {loaded && !form && (
              <>
                <Field label="Subject">
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} />
                </Field>
                <Field label="Details">
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Anything the fulfilling tier should know…" />
                </Field>
              </>
            )}

            {error && <p className="mb-3 text-xs text-danger">{error}</p>}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
