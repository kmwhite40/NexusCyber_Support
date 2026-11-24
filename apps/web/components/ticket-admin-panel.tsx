'use client';
import * as React from 'react';
import { api, ApiError, type Ticket } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Input, Textarea, Select, Field } from '@/components/ui/primitives';

// Admin controls on the ticket page: reassign to another agent / group (ticket.assign) and
// correct the ticket's own fields (ticket.edit). The server enforces both permissions and
// validates every assignee; the props only decide what is shown.

interface Agent { id: string; display_name: string | null; email: string }
interface Group { id: string; name: string; scope: string }

const LEVELS: Array<[number, string]> = [[1, '1 – Highest'], [2, '2 – High'], [3, '3 – Medium'], [4, '4 – Low']];

export function TicketAdminPanel({
  ticket,
  canAssign,
  canEdit,
  onChange,
}: {
  ticket: Ticket;
  canAssign: boolean;
  canEdit: boolean;
  onChange: () => void;
}) {
  if (!canAssign && !canEdit) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Admin</CardTitle></CardHeader>
      <CardBody className="space-y-5">
        {canAssign && <Reassign ticket={ticket} onChange={onChange} />}
        {canEdit && <EditFields ticket={ticket} onChange={onChange} />}
      </CardBody>
    </Card>
  );
}

function Reassign({ ticket, onChange }: { ticket: Ticket; onChange: () => void }) {
  const [opts, setOpts] = React.useState<{ agents: Agent[]; groups: Group[] } | null>(null);
  const [agent, setAgent] = React.useState(ticket.assigned_agent_id ?? '');
  const [group, setGroup] = React.useState(ticket.assignment_group_id ?? '');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    api.get<{ data: { agents: Agent[]; groups: Group[] } }>(`/tickets/${ticket.id}/assignees`)
      .then((r) => setOpts(r.data))
      .catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.detail : 'Could not load assignees' }));
  }, [ticket.id]);

  // Keep the selects in step when the ticket changes underneath (claim, escalate, another tab).
  React.useEffect(() => {
    setAgent(ticket.assigned_agent_id ?? '');
    setGroup(ticket.assignment_group_id ?? '');
  }, [ticket.assigned_agent_id, ticket.assignment_group_id]);

  const unchanged = agent === (ticket.assigned_agent_id ?? '') && group === (ticket.assignment_group_id ?? '');

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/tickets/${ticket.id}/assign`, { assignedAgentId: agent || null, assignmentGroupId: group || null });
      setMsg({ ok: true, text: 'Reassigned.' });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? (e.errors?.[0]?.message ?? e.detail) : 'Reassign failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-fg">Reassign</div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label className="mb-1 block text-xs text-muted" htmlFor="reassign-agent">Agent</label>
          <Select id="reassign-agent" className="h-9 w-full" value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!opts}>
            <option value="">Unassigned</option>
            {opts?.agents.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
          </Select>
        </div>
        <div className="min-w-[14rem] flex-1">
          <label className="mb-1 block text-xs text-muted" htmlFor="reassign-group">Group</label>
          <Select id="reassign-group" className="h-9 w-full" value={group} onChange={(e) => setGroup(e.target.value)} disabled={!opts}>
            <option value="">No group</option>
            {opts?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </div>
        <Button size="sm" onClick={save} disabled={busy || !opts || unchanged}>Reassign</Button>
      </div>
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-success' : 'text-danger'}`} role="status">{msg.text}</p>}
    </div>
  );
}

function EditFields({ ticket, onChange }: { ticket: Ticket; onChange: () => void }) {
  const initial = React.useCallback(() => ({
    subject: ticket.subject ?? '',
    description: ticket.description ?? '',
    category: ticket.category ?? '',
    impact: ticket.impact ?? 3,
    urgency: ticket.urgency ?? 3,
    reason: '',
  }), [ticket.subject, ticket.description, ticket.category, ticket.impact, ticket.urgency]);

  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [msg, setMsg] = React.useState<string | null>(null);

  const closed = ticket.status === 'closed';

  function start() {
    setF(initial());
    setErrors({});
    setMsg(null);
    setOpen(true);
  }

  async function save() {
    // Send only what changed: the server treats every key it receives as an edit.
    const was = initial();
    const patch: Record<string, unknown> = {};
    if (f.subject !== was.subject) patch.subject = f.subject;
    if (f.description !== was.description) patch.description = f.description;
    if (f.category !== was.category) patch.category = f.category;
    if (f.impact !== was.impact) patch.impact = f.impact;
    if (f.urgency !== was.urgency) patch.urgency = f.urgency;
    if (!Object.keys(patch).length) { setMsg('Nothing changed.'); return; }
    if (f.reason.trim()) patch.reason = f.reason.trim();

    setBusy(true);
    setErrors({});
    setMsg(null);
    try {
      await api.patch(`/tickets/${ticket.id}`, patch);
      setOpen(false);
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.errors?.length) setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
      setMsg(e instanceof ApiError ? e.detail : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted">
          {closed ? 'Closed tickets cannot be edited.' : 'Correct the subject, description, category or priority.'}
        </div>
        <Button size="sm" variant="outline" onClick={start} disabled={closed}>Edit ticket</Button>
      </div>
    );
  }

  const err = (k: string) => errors[k] && <p className="mt-1 text-xs text-danger">{errors[k]}</p>;

  return (
    <div>
      <div className="mb-3 text-xs font-medium text-fg">Edit ticket</div>
      <Field label="Subject">
        <Input value={f.subject} maxLength={300} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        {err('subject')}
      </Field>
      <Field label="Description">
        <Textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        {err('description')}
      </Field>
      <Field label="Category">
        <Input value={f.category} maxLength={120} onChange={(e) => setF({ ...f, category: e.target.value })} />
        {err('category')}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Impact">
          <Select className="h-9 w-full" value={f.impact} onChange={(e) => setF({ ...f, impact: Number(e.target.value) })}>
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          {err('impact')}
        </Field>
        <Field label="Urgency">
          <Select className="h-9 w-full" value={f.urgency} onChange={(e) => setF({ ...f, urgency: Number(e.target.value) })}>
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          {err('urgency')}
        </Field>
      </div>
      <p className="-mt-2 mb-4 text-xs text-muted">Priority is recalculated from impact and urgency, and open SLA deadlines move to match.</p>
      <Field label="Reason (optional)" hint="Recorded in the ticket timeline and audit log.">
        <Input value={f.reason} maxLength={2000} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </Field>
      {msg && <p className="mb-3 text-xs text-danger" role="status">{msg}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>Save changes</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
