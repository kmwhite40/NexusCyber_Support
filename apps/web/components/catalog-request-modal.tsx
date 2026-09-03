'use client';
// The service-catalog request dialog. Extracted from the catalog page so it can be tested
// directly: a page file may not export anything but the route, and the dismissal behaviour here
// is worth pinning — an accidental close used to discard a thirty-field form silently.
import * as React from 'react';
import { api, catalog, users, attachmentsApi, type CatalogItem, type Ticket, type CatalogForm, type FormFieldDef, ApiError } from '@/lib/api';
import { UserPicker } from '@/components/user-picker';
import { DynamicFormField, isFieldVisible } from '@/components/dynamic-form-field';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, Textarea, Field, Select } from '@/components/ui/primitives';
import { useAuth } from '@/components/auth-context';

/** Form fields whose options come from a live endpoint rather than the form definition. */
const OPTIONS_SOURCE_ENDPOINTS: Record<string, string> = {
  cloudpc_policies: '/provisioning/cloud-pc-policies',
};

export function RequestModal({
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

  // Dirty means the operator has typed something worth protecting. A catalog form can be thirty
  // fields long, so losing it to a stray click is expensive and silent.
  const formId = React.useId();
  // Compared against the INITIAL values, not against empty: `subject` is pre-filled with the
  // catalog item's name, so an emptiness test would call every untouched dialog dirty and prompt
  // on every Cancel. A confirm that always fires is one people learn to dismiss without reading,
  // which costs exactly the form it was added to protect.
  const dirty = Object.values(answers).some((v) => v !== undefined && v !== null && v !== '')
    || subject.trim() !== item.name.trim() || description.trim() !== '' || file !== null;

  const attemptClose = React.useCallback(() => {
    if (dirty && !window.confirm('Discard this request? Everything you have entered will be lost.')) return;
    onClose();
  }, [dirty, onClose]);

  // Escape still closes — but through the same guard, so it cannot silently discard a filled form.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') attemptClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attemptClose]);

  return (
    // No onClick on the backdrop. It used to call onClose, which meant any click reaching it
    // discarded the whole form without warning — including clicks from portalled dropdowns (the
    // user picker, date fields) that bubble straight past the card's stopPropagation. Dismissal
    // is deliberate now: Cancel or Escape, both guarded.
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm">
      {/* flex column so the body scrolls and the actions stay pinned; previously the buttons were
          the last thing inside the scroll area and a long form pushed Submit out of reach. */}
      <Card className="flex max-h-[90vh] w-full max-w-lg flex-col" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="shrink-0"><CardTitle>{item.name}</CardTitle></CardHeader>
        <CardBody className="min-h-0 flex-1 overflow-auto">
          {form && <p className="mb-4 text-xs text-muted">Required fields are marked with an asterisk<span className="text-danger">*</span></p>}
          <form id={formId} onSubmit={submit}>
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
          </form>
        </CardBody>
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-4">
          <Button type="submit" form={formId} disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button>
          <Button type="button" variant="ghost" onClick={attemptClose}>Cancel</Button>
        </div>
      </Card>
    </div>
  );
}
