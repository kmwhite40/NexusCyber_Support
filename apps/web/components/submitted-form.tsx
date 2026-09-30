'use client';
// The catalog form a request was submitted with, read back for the staff fulfilling it. The API
// (GET /tickets/:id/form) reassembles answers scattered across custom_fields, ticket columns and
// approval steps; this only lays them out. Personal details stay withheld until a pii.view
// holder explicitly reveals them, and that reveal is audited server-side.
//
// Holders of ticket.form.edit can also CORRECT answers here (PATCH /tickets/:id/form). Only the
// answers actually changed are sent; the server re-validates each against the form, refuses while
// a provisioning/offboarding run is in flight, and records an internal comment + audit entry.
// Personal details are editable only once revealed — you may not overwrite what you cannot see.
import * as React from 'react';
import { Lock, Pencil } from 'lucide-react';
import {
  api, ApiError, ticketForm,
  type SubmittedForm as Form, type SubmittedFormField, type SubmittedFormFieldDef,
} from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Field, Textarea } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';
import { DynamicFormField, isFieldVisible, groupFieldsBySection } from '@/components/dynamic-form-field';
import { UserPicker } from '@/components/user-picker';
import { clearFieldError } from '@/lib/ticket-actions';

const WIDE_TYPES = new Set(['textarea']);
const TERMINAL = new Set(['resolved', 'closed']);
const USER_TYPES = new Set(['user', 'user_multi']);

/** Fields whose options come from a live endpoint rather than the form definition. Same map as
 *  the catalog request dialog (catalog-request-modal.tsx), which owns the canonical copy. */
const OPTIONS_SOURCE_ENDPOINTS: Record<string, string> = {
  cloudpc_policies: '/provisioning/cloud-pc-policies',
  entra_groups: '/provisioning/groups',
};

function blankToNull(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return v.length ? v : null;
  return v;
}

export function SubmittedForm({
  ticketId, canViewPii, canEdit = false, ticketStatus, organizationId, onSaved,
}: {
  ticketId: string;
  canViewPii: boolean;
  /** Caller holds ticket.form.edit. */
  canEdit?: boolean;
  ticketStatus?: string;
  /** The ticket's org — people pickers search its roster. */
  organizationId?: string;
  /** Called after a successful edit, e.g. to reload the ticket's comments and subject. */
  onSaved?: () => void;
}) {
  const [form, setForm] = React.useState<Form | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revealing, setRevealing] = React.useState(false);

  // Edit mode.
  const [editing, setEditing] = React.useState(false);
  const [initial, setInitial] = React.useState<Record<string, unknown>>({});
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});
  const [reason, setReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [dynamicOptions, setDynamicOptions] = React.useState<Record<string, string[]>>({});
  const [optionsTruncated, setOptionsTruncated] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    let live = true;
    ticketForm.get(ticketId)
      .then((r) => { if (live) setForm(r.data); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.detail : 'Could not load the submitted form'); });
    return () => { live = false; };
  }, [ticketId]);

  async function reveal() {
    setRevealing(true);
    setError(null);
    try {
      const next = (await ticketForm.get(ticketId, true)).data;
      setForm(next);
      // Revealing mid-edit: take the now-visible PII answers as their starting values, without
      // disturbing anything already typed into other fields.
      if (editing) {
        const pii = Object.fromEntries(
          next.sections.flatMap((s) => s.fields).filter((f) => f.sensitive && f.value !== null).map((f) => [f.key, f.value]),
        );
        setInitial((cur) => ({ ...cur, ...pii }));
        setAnswers((cur) => ({ ...pii, ...cur }));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not reveal personal details');
    } finally {
      setRevealing(false);
    }
  }

  const byKey = React.useMemo(
    () => new Map((form?.sections ?? []).flatMap((s) => s.fields ?? []).map((f) => [f.key, f] as const)),
    [form],
  );
  // Names for people already in the answers, so pre-filled pickers show names rather than UUIDs.
  const userLabels = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of byKey.values()) {
      if (!USER_TYPES.has(f.data_type) || f.value === null) continue;
      const ids = Array.isArray(f.value) ? f.value : [f.value];
      const shown = Array.isArray(f.display) ? f.display : [f.display];
      ids.forEach((id, i) => { if (typeof id === 'string' && shown[i]) out[id] = String(shown[i]); });
    }
    return out;
  }, [byKey]);

  const piiEditable = canViewPii && form?.pii !== 'withheld' && form?.pii !== 'purged';
  const lockReason = (f: SubmittedFormFieldDef): string | null => {
    if (f.locked) return f.locked;
    if (f.sensitive && !canViewPii) return 'Personal details can only be changed by staff with PII access.';
    if (f.sensitive && !piiEditable) return 'Reveal personal details to edit this answer.';
    return null;
  };

  const terminal = ticketStatus ? TERMINAL.has(ticketStatus) : false;
  // `fields` arrived with the edit feature; an API that predates it (e.g. mid-deploy) omits it.
  const hasFields = !!form && (form.fields ?? []).some((f) => f.data_type !== 'attachment');
  const showEdit = canEdit && !terminal && hasFields && !editing;
  const blocked = form?.edit?.blocked ?? null;

  function startEdit() {
    if (!form) return;
    const a: Record<string, unknown> = {};
    for (const f of byKey.values()) if (f.value !== null) a[f.key] = f.value;
    setInitial(a);
    setAnswers(a);
    setReason('');
    setEditError(null);
    setFieldErrors({});
    setEditing(true);
    for (const f of form.fields) {
      if (!f.options_source || dynamicOptions[f.key]) continue;
      const url = OPTIONS_SOURCE_ENDPOINTS[f.options_source];
      if (!url) continue;
      api.get<{ data: string[]; truncated?: boolean }>(url)
        .then((r) => {
          setDynamicOptions((cur) => ({ ...cur, [f.key]: r.data }));
          setOptionsTruncated((cur) => ({ ...cur, [f.key]: r.truncated === true }));
        })
        .catch(() => { /* keep the static options; the server re-validates regardless */ });
    }
  }

  const set = (key: string, v: unknown) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    setFieldErrors((e) => clearFieldError(e, key));
  };

  /** Only answers that actually changed, and only for fields still shown — the server drops
   *  answers whose condition an edit turns off, exactly as a submission would. */
  function changedAnswers(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const f of form?.fields ?? []) {
      if (f.data_type === 'attachment' || lockReason(f)) continue;
      if (!isFieldVisible(f, answers)) continue;
      const now = blankToNull(answers[f.key]);
      if (JSON.stringify(now) !== JSON.stringify(blankToNull(initial[f.key]))) patch[f.key] = now;
    }
    return patch;
  }
  const pending = editing ? changedAnswers() : {};
  const pendingCount = Object.keys(pending).length;

  async function save() {
    if (!form) return;
    if (pendingCount === 0) { setEditError('Nothing has changed.'); return; }
    setSaving(true);
    setEditError(null);
    setFieldErrors({});
    try {
      const r = await ticketForm.edit(ticketId, pending, reason.trim() || undefined, form.pii === 'included');
      setForm(r.data);
      setEditing(false);
      onSaved?.();
    } catch (e) {
      // Keep everything typed; mark the fields the server rejected where they are.
      if (e instanceof ApiError) {
        setEditError(e.detail);
        if (e.errors?.length) setFieldErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
      } else {
        setEditError('Could not save the changes');
      }
    } finally {
      setSaving(false);
    }
  }

  const renderUserPicker = (f: { key: string }, multi: boolean) =>
    multi ? (
      <UserPicker
        value={(answers[f.key] as string[]) ?? []} onChange={(v) => set(f.key, v)}
        organizationId={organizationId} multiple labels={userLabels}
      />
    ) : (
      <UserPicker
        value={(answers[f.key] as string) ?? null} onChange={(v) => set(f.key, v)}
        organizationId={organizationId} labels={userLabels}
      />
    );

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Submitted form</CardTitle>
          {form?.form_name && <p className="mt-0.5 text-xs text-muted">{form.form_name}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {form?.pii === 'withheld' && canViewPii && (
            <div className="flex flex-col items-end gap-1">
              <Button size="sm" variant="outline" onClick={reveal} disabled={revealing}>
                <Lock className="h-3.5 w-3.5" strokeWidth={1.75} />
                {revealing ? 'Revealing…' : 'Reveal personal details'}
              </Button>
              <span className="text-[11px] text-muted">Each reveal is recorded in the audit log.</span>
            </div>
          )}
          {form?.pii === 'included' && <Badge tone="warning">personal details shown</Badge>}
          {showEdit && (
            <div className="flex flex-col items-end gap-1">
              <Button size="sm" variant="outline" onClick={startEdit} disabled={!!blocked}>
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                Edit answers
              </Button>
              {blocked && <span className="max-w-xs text-right text-[11px] text-muted">{blocked}</span>}
            </div>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!form && !error && <div className="space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-24" /></div>}

        {form && editing ? (
          <EditBody
            form={form}
            answers={answers}
            byKey={byKey}
            lockReason={lockReason}
            fieldErrors={fieldErrors}
            dynamicOptions={dynamicOptions}
            optionsTruncated={optionsTruncated}
            onChange={set}
            renderUserPicker={renderUserPicker}
          />
        ) : (
          <>
            {form && (form.sections ?? []).length === 0 && <p className="text-sm text-muted">No answers were recorded for this request.</p>}
            {(form?.sections ?? []).map((s) => (
              <section key={s.section ?? '_'} className="space-y-2">
                {s.section && (
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{s.section}</h4>
                )}
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {s.fields.map((f) => (
                    <div key={f.key} className={WIDE_TYPES.has(f.data_type) ? 'sm:col-span-2' : undefined}>
                      <dt className="text-xs text-muted">{f.label}</dt>
                      <dd className="mt-0.5 text-sm text-fg">
                        <Answer field={f} pii={form?.pii ?? 'none'} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </>
        )}

        {editing && (
          <div className="space-y-3 border-t border-border pt-4">
            <Field label="Reason for change *" hint="Recorded with the change in the ticket history and audit log.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. HR corrected the start date" />
            </Field>
            {editError && <p className="text-sm text-danger">{editError}</p>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted">
                {pendingCount === 0 ? 'No changes yet' : `${pendingCount} answer${pendingCount === 1 ? '' : 's'} changed`}
              </span>
              <Button variant="ghost" onClick={() => { setEditing(false); setEditError(null); setFieldErrors({}); }} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || pendingCount === 0 || !reason.trim()}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}

        {form?.pii === 'withheld' && !canViewPii && (
          <p className="text-xs text-muted">Personal details on this request are only visible to staff with PII access.</p>
        )}
      </CardBody>
    </Card>
  );
}

function EditBody({
  form, answers, byKey, lockReason, fieldErrors, dynamicOptions, optionsTruncated, onChange, renderUserPicker,
}: {
  form: Form;
  answers: Record<string, unknown>;
  byKey: Map<string, SubmittedFormField>;
  lockReason: (f: SubmittedFormFieldDef) => string | null;
  fieldErrors: Record<string, string>;
  dynamicOptions: Record<string, string[]>;
  optionsTruncated: Record<string, boolean>;
  onChange: (key: string, v: unknown) => void;
  renderUserPicker: (f: { key: string }, multi: boolean) => React.ReactNode;
}) {
  const fields = (form.fields ?? []).filter((f) => f.data_type !== 'attachment') as SubmittedFormFieldDef[];
  // Error messages for keys that have no control here (unknown/removed fields) still need showing.
  const orphanErrors = Object.entries(fieldErrors).filter(([k]) => !fields.some((f) => f.key === k));
  return (
    <div className="space-y-5">
      {groupFieldsBySection(fields).map((g, i) => (
        <section key={`${g.section ?? '_'}-${i}`} className="space-y-2">
          {g.section && <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{g.section}</h4>}
          <div className="grid gap-x-6 sm:grid-cols-2">
            {(g.fields as SubmittedFormFieldDef[]).map((f) => {
              if (!isFieldVisible(f, answers)) return null;
              const locked = lockReason(f);
              const wide = WIDE_TYPES.has(f.data_type) || f.data_type === 'multiselect' || f.data_type === 'user_multi';
              if (locked) {
                const shown = byKey.get(f.key);
                return (
                  <div key={f.key} className={`mb-4 ${wide ? 'sm:col-span-2' : ''}`}>
                    <p className="text-xs text-muted">{f.label}</p>
                    <div className="mt-0.5 text-sm text-fg">
                      {shown ? <Answer field={shown} pii={form.pii} /> : <span className="text-muted">—</span>}
                    </div>
                    <p className="mt-0.5 flex items-start gap-1 text-[11px] text-muted">
                      <Lock className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} /> {locked}
                    </p>
                  </div>
                );
              }
              return (
                <div key={f.key} className={wide ? 'sm:col-span-2' : undefined}>
                  <DynamicFormField
                    field={f}
                    value={answers[f.key]}
                    answers={answers}
                    options={dynamicOptions[f.key] ?? f.options}
                    optionsTruncated={optionsTruncated[f.key] ?? false}
                    onChange={onChange}
                    renderUserPicker={renderUserPicker}
                    error={fieldErrors[f.key]}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {orphanErrors.map(([k, m]) => <p key={k} className="text-xs text-danger">{m}</p>)}
    </div>
  );
}

function Answer({ field, pii }: { field: SubmittedFormField; pii: Form['pii'] }) {
  if (field.sensitive && field.display === null) {
    if (pii === 'withheld') {
      return <span className="inline-flex items-center gap-1 text-muted"><Lock className="h-3 w-3" strokeWidth={1.75} /> Withheld</span>;
    }
    if (pii === 'purged') return <span className="text-muted">Deleted at resolution</span>;
  }
  const d = field.display;
  if (d === null || (Array.isArray(d) && d.length === 0)) return <span className="text-muted">—</span>;
  if (Array.isArray(d)) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {d.map((x, i) => <Badge key={`${x}-${i}`}>{x}</Badge>)}
      </span>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{d}</span>;
}
