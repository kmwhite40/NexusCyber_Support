'use client';
// Dynamic field renderer for catalog request forms. Extracted from the catalog page's
// inline `data_type` switch once the SBS onboarding form grew from 15 to 32 fields (four
// conditionally visible via `visible_when`, four PII marked `sensitive`). Renders a single
// field per the shape returned by the API (apps/api/src/modules/forms.ts `loadFields`).
import * as React from 'react';
import type { FormFieldDef, VisibleWhen } from '@/lib/api';
import { Field, Input, Select, Textarea, Checkbox } from '@/components/ui/primitives';
import { Paperclip } from 'lucide-react';

export type { VisibleWhen };

/**
 * Is this field shown, given the current answers? Fields with no condition are always
 * shown. This MUST behave identically to the server's `isFieldVisible` in
 * apps/api/src/modules/form-fields.ts. That is no longer a matter of trust: the two
 * function bodies are pinned to each other character-for-character, and the behaviour is
 * pinned to a shared case table, by apps/api/test/form-visibility-parity.test.ts —
 * editing either copy alone fails that test.
 *
 * In particular: a referenced field that is absent from `answers`, or whose value is not
 * a string, means NOT visible — same as the server.
 */
export function isFieldVisible(field: FormFieldDef, answers: Record<string, unknown>): boolean {
  const cond = field.visible_when;
  if (!cond) return true;
  const actual = answers[cond.field];
  if (typeof actual !== 'string') return false;
  return 'equals' in cond ? actual === cond.equals : cond.in.includes(actual);
}

/**
 * `<input type="datetime-local">` yields a bare local wall-clock string — "2026-09-05T17:00",
 * with no zone. The API's `datetime` validator requires a zone designator, because "17:00"
 * without one names five different instants across an org, and this field schedules a
 * termination. So the browser's own offset is attached here, at the point where it is actually
 * known, rather than guessed server-side.
 */
export function localInputToIsoInstant(local: string): string {
  if (!local) return '';
  const d = new Date(local); // the browser parses a zone-less string as LOCAL time
  if (Number.isNaN(d.getTime())) return local;
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const zone = offsetMinutes === 0
    ? 'Z'
    : `${offsetMinutes > 0 ? '+' : '-'}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

/** The inverse, for redisplaying a stored instant in the picker. */
export function isoInstantToLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


/**
 * Group fields into CONSECUTIVE runs by section.
 *
 * Runs, not buckets: merging every field with the same name would silently reorder someone's
 * form. The onboarding intake is stored contiguously (migration 0077) so each section appears
 * once; if a form is ever edited into an interleaved order, this renders it as it actually is
 * rather than quietly rearranging it.
 */
export function groupFieldsBySection(fields: FormFieldDef[]): Array<{ section: string | null; fields: FormFieldDef[] }> {
  const groups: Array<{ section: string | null; fields: FormFieldDef[] }> = [];
  for (const f of fields) {
    const section = f.section ?? null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.fields.push(f);
    else groups.push({ section, fields: [f] });
  }
  return groups;
}

export function DynamicFormField({
  field, value, answers, options, file, onChange, onFileChange, renderUserPicker,
}: {
  field: FormFieldDef;
  /** answers[field.key] — passed separately so callers can read/derive it however they like. */
  value: unknown;
  /** The full answers bag, needed to evaluate this (and other fields') visibility. */
  answers: Record<string, unknown>;
  /** Resolved options for a select field — static field.options, or options_source results
   *  once fetched (callers are responsible for the options_source fetch + fallback). */
  options: string[];
  file?: File | null;
  onChange: (key: string, value: unknown) => void;
  onFileChange?: (file: File | null) => void;
  renderUserPicker: (field: FormFieldDef, multi: boolean) => React.ReactNode;
}) {
  if (!isFieldVisible(field, answers)) return null;
  const set = (v: unknown) => onChange(field.key, v);
  const label = field.required ? `${field.label} *` : field.label;
  const hint = field.sensitive ? 'Sensitive — handled and stored separately from other request data.' : undefined;

  return (
    <Field label={label} hint={hint}>
      {field.data_type === 'textarea' ? (
        <Textarea value={(value as string) ?? ''} onChange={(e) => set(e.target.value)} />
      ) : field.data_type === 'select' ? (
        <Select value={(value as string) ?? ''} onChange={(e) => set(e.target.value)}>
          <option value="" disabled>Select…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : field.data_type === 'checkbox' ? (
        <Checkbox checked={!!value} onChange={(e) => set(e.target.checked)} />
      ) : field.data_type === 'user' ? (
        renderUserPicker(field, false)
      ) : field.data_type === 'user_multi' ? (
        renderUserPicker(field, true)
      ) : field.data_type === 'attachment' ? (
        <div className="rounded-md border border-dashed border-border p-3">
          <div className="flex items-center gap-2">
            <Paperclip className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.75} />
            <Input
              type="file"
              onChange={(e) => onFileChange?.(e.target.files?.[0] ?? null)}
              className="border-0 bg-transparent p-0 text-xs"
            />
          </div>
          {file && <span className="mt-1 block text-xs text-fg">{file.name}</span>}
        </div>
      ) : (
        <Input
          type={
            field.data_type === 'email' ? 'email'
              : field.data_type === 'phone' ? 'tel'
              : field.data_type === 'date' ? 'date'
              : field.data_type === 'datetime' ? 'datetime-local'
              : field.data_type === 'number' ? 'number'
              : 'text'
          }
          value={
            field.data_type === 'datetime'
              ? isoInstantToLocalInput((value as string) ?? '')
              : (value as string) ?? ''
          }
          placeholder={field.key === 'summary' ? 'e.g. Create an account on Jira' : undefined}
          onChange={(e) => set(
            field.data_type === 'datetime' ? localInputToIsoInstant(e.target.value) : e.target.value,
          )}
        />
      )}
    </Field>
  );
}
