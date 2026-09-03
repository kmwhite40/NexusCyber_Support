'use client';
// Service catalog — the in-scope helpdesk request types as guided, workflow-backed
// requests (docs/nexus/workflows/service-desk-workflows.md).
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api, catalog, users, attachmentsApi, type CatalogItem, type Ticket, type CatalogForm, type FormFieldDef, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { UserPicker } from '@/components/user-picker';
import { DynamicFormField, isFieldVisible } from '@/components/dynamic-form-field';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, Input, Textarea, Field, Select } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';
import { Clock } from 'lucide-react';

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

  // Deep-link support: /catalog?item=<key> (e.g. from the portal search) opens that
  // item's request form directly instead of landing on the full catalog.
  React.useEffect(() => {
    if (!items || items.length === 0) return;
    const key = new URLSearchParams(window.location.search).get('item');
    if (!key) return;
    const match = items.find((i) => i.key === key);
    if (match) setActive(match);
  }, [items]);

  const grouped = (items ?? []).reduce<Record<string, CatalogItem[]>>((acc, it) => {
    (acc[it.category] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Service catalog</h1>
        <p className="mt-1 text-sm text-muted">
          Request a standard service. We&rsquo;ll take care of the rest and keep you updated, asking
          for approval where it&rsquo;s needed.
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
                      {it.requires_approval && <Badge tone="warning">Needs approval</Badge>}
                    </div>
                    <p className="flex-1 text-xs leading-relaxed text-muted">
                      {it.description ?? 'Submit this request and our team will handle it for you.'}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                        <Clock className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                        Typically done in {Math.round(it.sla_resolution_min / 60)}h
                      </span>
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

// Provider name (form_fields.options_source) -> the endpoint that lists its choices.
// Seeded providers: `cloudpc_policies` (0054). Add a row here when a new provider is seeded.
const OPTIONS_SOURCE_ENDPOINTS: Record<string, string> = {
  cloudpc_policies: '/provisioning/cloud-pc-policies',
};

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
  // Resolved options for fields with an `options_source` (e.g. cloud_pc_policy), keyed by
  // field key. Populated by the effect below; falls back to the field's static `options`
  // until (or unless) that fetch succeeds.
  const [dynamicOptions, setDynamicOptions] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    catalog.form(item.key).then((r) => setForm(r.form)).catch(() => setForm(null)).finally(() => setLoaded(true));
  }, [item.key]);

  // Fetch options for any options_source field once the form loads. The endpoint is keyed
  // off the provider NAME the field declares (form_fields.options_source), not hardcoded —
  // an unknown provider fetches nothing rather than silently hitting the Cloud PC endpoint.
  // The referenced endpoint doesn't exist until Phase 2 (Task 15); any failure (network
  // error or 404) is swallowed and the field just keeps using its static `field.options`
  // (empty array today) instead of breaking the form.
  React.useEffect(() => {
    for (const f of form?.fields ?? []) {
      if (!f.options_source) continue;
      const url = OPTIONS_SOURCE_ENDPOINTS[f.options_source];
      if (!url) continue;
      api.get<{ data: string[] }>(url)
        .then((r) => setDynamicOptions((cur) => ({ ...cur, [f.key]: r.data })))
        .catch(() => {});
    }
  }, [form]);

  const searchOrg = isAgent ? orgId : me?.organization_id ?? undefined;
  const set = (key: string, v: unknown) => setAnswers((a) => ({ ...a, [key]: v }));
  const renderUserPicker = (f: FormFieldDef, multi: boolean) =>
    multi ? (
      <UserPicker value={(answers[f.key] as string[]) ?? []} onChange={(v) => set(f.key, v)} organizationId={searchOrg} multiple />
    ) : (
      <UserPicker value={(answers[f.key] as string) ?? null} onChange={(v) => set(f.key, v)} organizationId={searchOrg} />
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Drop answers for fields the user can't currently see — a value entered before a
      // condition changed (e.g. answering `end_date` then switching `access_type` away
      // from "Temporary") must not be submitted as if it were still given.
      const visibleAnswers = form
        ? Object.fromEntries(
            Object.entries(answers).filter(([key]) => {
              const f = form.fields.find((ff) => ff.key === key);
              return !f || isFieldVisible(f, answers);
            }),
          )
        : answers;
      const body = form
        ? { organizationId: isAgent ? orgId : undefined, answers: visibleAnswers }
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" onClick={onClose}>
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
              <DynamicFormField
                key={f.key}
                field={f}
                value={answers[f.key]}
                answers={answers}
                options={dynamicOptions[f.key] ?? f.options}
                file={file}
                onChange={set}
                onFileChange={setFile}
                renderUserPicker={renderUserPicker}
              />
            ))}

            {loaded && !form && (
              <>
                <Field label="Subject">
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} />
                </Field>
                <Field label="Details">
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Anything the support team should know…" />
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
