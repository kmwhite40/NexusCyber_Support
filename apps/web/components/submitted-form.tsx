'use client';
// The catalog form a request was submitted with, read back for the staff fulfilling it. The API
// (GET /tickets/:id/form) reassembles answers scattered across custom_fields, ticket columns and
// approval steps; this only lays them out. Personal details stay withheld until a pii.view
// holder explicitly reveals them, and that reveal is audited server-side.
import * as React from 'react';
import { Lock } from 'lucide-react';
import { ApiError, ticketForm, type SubmittedForm as Form, type SubmittedFormField } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';

const WIDE_TYPES = new Set(['textarea']);

export function SubmittedForm({ ticketId, canViewPii }: { ticketId: string; canViewPii: boolean }) {
  const [form, setForm] = React.useState<Form | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revealing, setRevealing] = React.useState(false);

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
      setForm((await ticketForm.get(ticketId, true)).data);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not reveal personal details');
    } finally {
      setRevealing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Submitted form</CardTitle>
          {form?.form_name && <p className="mt-0.5 text-xs text-muted">{form.form_name}</p>}
        </div>
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
      </CardHeader>
      <CardBody className="space-y-5">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!form && !error && <div className="space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-24" /></div>}
        {form && form.sections.length === 0 && <p className="text-sm text-muted">No answers were recorded for this request.</p>}
        {form?.sections.map((s) => (
          <section key={s.section ?? '_'} className="space-y-2">
            {s.section && (
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{s.section}</h4>
            )}
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {s.fields.map((f) => (
                <div key={f.key} className={WIDE_TYPES.has(f.data_type) ? 'sm:col-span-2' : undefined}>
                  <dt className="text-xs text-muted">{f.label}</dt>
                  <dd className="mt-0.5 text-sm text-fg">
                    <Answer field={f} pii={form.pii} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {form?.pii === 'withheld' && !canViewPii && (
          <p className="text-xs text-muted">Personal details on this request are only visible to staff with PII access.</p>
        )}
      </CardBody>
    </Card>
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
