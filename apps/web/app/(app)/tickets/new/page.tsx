'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Ticket } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Input, Textarea, Select, Field, Badge } from '@/components/ui/primitives';
import { Gauge } from 'lucide-react';

const IMPACT = [
  { v: 1, label: 'Most of my organization' },
  { v: 2, label: 'A large group' },
  { v: 3, label: 'A small group' },
  { v: 4, label: 'Just me' },
];
const URGENCY = [
  { v: 1, label: "Critical — I can't work" },
  { v: 2, label: 'High — blocking me soon' },
  { v: 3, label: 'Medium — needs attention' },
  { v: 4, label: 'Low — whenever you can' },
];
// Impact x Urgency -> Priority preview (mirrors server docs/nexus/03 §F.4)
const MATRIX: Record<number, Record<number, string>> = {
  1: { 1: 'P1', 2: 'P1', 3: 'P2', 4: 'P3' },
  2: { 1: 'P1', 2: 'P2', 3: 'P2', 4: 'P3' },
  3: { 1: 'P2', 2: 'P2', 3: 'P3', 4: 'P4' },
  4: { 1: 'P3', 2: 'P3', 3: 'P4', 4: 'P4' },
};

export default function NewTicketPage() {
  const router = useRouter();
  const { me } = useAuth();
  const [form, setForm] = React.useState({ type: 'incident', subject: '', description: '', impact: 3, urgency: 3 });
  const [orgs, setOrgs] = React.useState<Array<{ id: string; name: string }>>([]);
  const [orgId, setOrgId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (me?.plane === 'nexus') {
      api.get<{ data: Array<{ id: string; name: string }> }>('/organizations').then((r) => {
        setOrgs(r.data);
        if (r.data[0]) setOrgId(r.data[0].id);
      }).catch(() => {});
    }
  }, [me]);

  // Prefill from query params (e.g. when a KB article didn't resolve the reader's issue).
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const subject = sp.get('subject');
    const description = sp.get('description');
    const type = sp.get('type');
    if (subject || description || type) {
      setForm((f) => ({
        ...f,
        ...(subject ? { subject: subject.slice(0, 300) } : {}),
        ...(description ? { description } : {}),
        ...(type ? { type } : {}),
      }));
    }
  }, []);

  const priority = MATRIX[form.impact][form.urgency];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: any = { ...form };
      if (me?.plane === 'nexus') payload.organizationId = orgId;
      const ticket = await api.post<Ticket>('/tickets', payload);
      router.push(`/tickets/${ticket.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not create ticket');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submit a ticket</h1>
        <p className="mt-1 text-sm text-muted">We’ll get it to the right team and keep you updated.</p>
      </div>

      <Card>
        <CardBody>
          <form onSubmit={submit}>
            {me?.plane === 'nexus' && (
              <Field label="Customer organization" hint="Agents create on behalf of a customer.">
                <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="incident">Incident</option>
                <option value="service_request">Service request</option>
                <option value="access_request">Access request</option>
                <option value="customer_question">Question</option>
              </Select>
            </Field>
            <Field label="Subject">
              <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Short summary of the issue" required minLength={3} maxLength={300} />
            </Field>
            <Field label="Description">
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What happened, what you expected, any error messages…" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="How many people are affected?">
                <Select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}>
                  {IMPACT.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
                </Select>
              </Field>
              <Field label="How urgent is it?">
                <Select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}>
                  {URGENCY.map((u) => <option key={u.v} value={u.v}>{u.label}</option>)}
                </Select>
              </Field>
            </div>

            <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface-2/50 px-3 py-2.5">
              <Gauge className="h-4 w-4 text-muted" strokeWidth={1.75} />
              <span className="text-xs text-muted">Priority</span>
              <Badge tone={priority === 'P1' ? 'danger' : priority === 'P2' ? 'warning' : 'brand'}>{priority}</Badge>
              <span className="ml-auto text-xs text-muted">Set automatically from your answers</span>
            </div>

            {error && <p className="mb-3 text-xs text-danger">{error}</p>}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit ticket'}</Button>
              <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
