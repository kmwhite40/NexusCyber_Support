'use client';
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Textarea, SegmentedControl } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Change {
  id: string;
  title: string;
  change_type: 'standard' | 'normal' | 'emergency';
  risk: 'low' | 'medium' | 'high';
  status: string;
  window_start: string | null;
  window_end: string | null;
}
interface CabStep { id: string; approver_id: string; decision: string | null; reason: string | null }
interface ChangeVote { id: string; voter_id: string; vote: 'approve' | 'reject' | 'abstain' | null; reason: string | null; ad_hoc: boolean }
interface VoteTally { approve: number; reject: number; abstain: number; pending: number; cast: number; roster: number }
interface ChangeDetail extends Change {
  description: string | null;
  backout_plan: string | null;
  cab_steps: CabStep[];
  votes: ChangeVote[];
  cab_tally: VoteTally | null;
  cab_quorum: number | null;
  cab_threshold: string | null;
  vote_deadline: string | null;
}

const statusTone = (s: string) =>
  s === 'approved' || s === 'closed' ? 'success' : s === 'rejected' ? 'danger' : s === 'cab_review' ? 'warning' : 'neutral';

export default function ChangesPage() {
  const { me, can } = useAuth();
  const [rows, setRows] = React.useState<Change[] | null>(null);
  const [sel, setSel] = React.useState<ChangeDetail | null>(null);
  const [view, setView] = React.useState<'list' | 'calendar'>('list');
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ title: '', changeType: 'normal', risk: 'medium', description: '' });
  const [err, setErr] = React.useState<string | null>(null);

  const canVote = can('change.vote');
  const canImplement = can('change.implement');

  const load = React.useCallback(() => {
    api.get<{ data: Change[] }>('/changes').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);
  React.useEffect(load, [load]);

  function open(id: string) {
    api.get<ChangeDetail>(`/changes/${id}`).then(setSel).catch(() => {});
  }

  async function create() {
    setErr(null);
    try {
      const c = await api.post<Change>('/changes', form);
      setCreating(false);
      setForm({ title: '', changeType: 'normal', risk: 'medium', description: '' });
      load();
      open(c.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to create change');
    }
  }

  async function submitCab() {
    if (!sel) return;
    // The standing board (GET/PUT /cab/board) supplies the roster. The raiser is NEVER
    // added as their own voter — segregation of duties; the API recuses them anyway. A
    // memberless board therefore fails loudly here, which is the correct signal to go
    // configure one. Standard changes auto-approve and ignore the roster entirely.
    setErr(null);
    try {
      await api.post(`/changes/${sel.id}/submit-cab`, {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to submit to the CAB');
      return;
    }
    open(sel.id); load();
  }
  async function decide(vote: 'approve' | 'reject' | 'abstain') {
    if (!sel) return;
    setErr(null);
    try {
      await api.post(`/changes/${sel.id}/vote`, { vote });
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to record your vote');
      return;
    }
    open(sel.id); load();
  }
  async function schedule() {
    if (!sel) return;
    const start = new Date(Date.now() + 86400000); start.setUTCHours(2, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3600000);
    await api.post(`/changes/${sel.id}/schedule`, { windowStart: start.toISOString(), windowEnd: end.toISOString() }).catch(() => {});
    open(sel.id); load();
  }
  async function recordPir(outcome: string) {
    if (!sel) return;
    await api.post(`/changes/${sel.id}/pir`, { outcome }).catch(() => {});
    open(sel.id); load();
  }
  async function advance(to: string) {
    if (!sel) return;
    await api.post(`/changes/${sel.id}/transition`, { to }).catch(() => {});
    open(sel.id); load();
  }

  const nextImpl: Record<string, string> = { scheduled: 'implementing', implementing: 'review', review: 'closed' };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Change management</h1>
          <p className="mt-1 text-sm text-muted">Standard, normal, and emergency changes with CAB approval and a change calendar.</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<'list' | 'calendar'>
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'calendar', label: 'Calendar' },
            ]}
          />
          {can('change.create') && <Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'New change'}</Button>}
        </div>
      </div>

      {creating && (
        <Card>
          <CardBody className="space-y-3">
            <Input placeholder="Change title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Textarea
              placeholder="Description, implementation & backout plan"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
            />
            <div className="flex gap-2">
              <Select className="w-40" value={form.changeType} onChange={(e) => setForm({ ...form, changeType: e.target.value })}>
                <option value="standard">Standard (pre-approved)</option>
                <option value="normal">Normal (CAB)</option>
                <option value="emergency">Emergency</option>
              </Select>
              <Select className="w-32" value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}>
                <option value="low">Low risk</option>
                <option value="medium">Medium risk</option>
                <option value="high">High risk</option>
              </Select>
              <Button onClick={create} disabled={!form.title.trim()} className="ml-auto">Create</Button>
            </div>
            {err && <p className="text-xs text-danger">{err}</p>}
          </CardBody>
        </Card>
      )}

      {view === 'calendar' && <ChangeCalendar onOpen={open} />}

      {view === 'list' && (
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader><CardTitle>Changes</CardTitle></CardHeader>
          <CardBody className="px-0 pt-0">
            {!rows ? (
              <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              <DataTable<Change>
                rows={rows}
                onRowClick={(c) => open(c.id)}
                empty={<EmptyState title="No changes" description="Create a change to begin the CAB workflow." />}
                columns={[
                  { key: 'title', header: 'Change', render: (c) => <span className="font-medium text-fg">{c.title}</span> },
                  { key: 'type', header: 'Type', render: (c) => <Badge tone="neutral">{c.change_type}</Badge> },
                  { key: 'risk', header: 'Risk', render: (c) => <Badge tone={c.risk === 'high' ? 'danger' : c.risk === 'medium' ? 'warning' : 'neutral'}>{c.risk}</Badge> },
                  { key: 'status', header: 'Status', render: (c) => <Badge tone={statusTone(c.status) as any}>{c.status.replace(/_/g, ' ')}</Badge> },
                  { key: 'window', header: 'Window', render: (c) => <span className="text-xs text-muted">{c.window_start ? new Date(c.window_start).toLocaleString() : '—'}</span> },
                ]}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{sel ? 'Change detail' : 'Select a change'}</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            {!sel ? (
              <EmptyState title="Nothing selected" description="Pick a change from the list." />
            ) : (
              <>
                <div>
                  <div className="text-sm font-medium text-fg">{sel.title}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone="neutral">{sel.change_type}</Badge>
                    <Badge tone={statusTone(sel.status) as any}>{sel.status.replace(/_/g, ' ')}</Badge>
                  </div>
                </div>
                {sel.description && <p className="whitespace-pre-wrap text-xs text-fg/80">{sel.description}</p>}

                {sel.votes.length === 0 && sel.cab_steps.length > 0 && (
                  // Pre-voting changes approved through approvals/approval_steps.
                  <div className="rounded-md border border-border p-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">CAB board (legacy approval)</div>
                    {sel.cab_steps.map((s) => (
                      <div key={s.id} className="flex items-center justify-between text-xs">
                        <span className="text-muted">approver</span>
                        <Badge tone={s.decision === 'approved' ? 'success' : s.decision === 'rejected' ? 'danger' : 'neutral'}>{s.decision ?? 'pending'}</Badge>
                      </div>
                    ))}
                  </div>
                )}

                {sel.votes.length > 0 && (
                  <div className="rounded-md border border-border p-2">
                    <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <span>CAB board</span>
                      {sel.cab_tally && (
                        <span className="normal-case tracking-normal">
                          {sel.cab_tally.cast} of {sel.cab_tally.roster} cast · quorum {sel.cab_quorum ?? '—'} · {(sel.cab_threshold ?? 'majority').replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    {sel.votes.map((v) => (
                      <div key={v.id} className="flex items-center justify-between text-xs">
                        <span className="text-muted">{v.ad_hoc ? 'ad-hoc reviewer' : 'board member'}</span>
                        <Badge tone={v.vote === 'approve' ? 'success' : v.vote === 'reject' ? 'danger' : 'neutral'}>{v.vote ?? 'pending'}</Badge>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  {sel.status === 'draft' && can('change.create') && <Button size="sm" onClick={submitCab}>Submit to CAB</Button>}
                  {sel.status === 'cab_review' && canVote && sel.votes.some((v) => v.voter_id === me?.id) && (
                    <>
                      <Button size="sm" onClick={() => decide('approve')}>Approve</Button>
                      <Button size="sm" variant="danger" onClick={() => decide('reject')}>Reject</Button>
                      <Button size="sm" variant="subtle" onClick={() => decide('abstain')}>Abstain</Button>
                    </>
                  )}
                  {sel.status === 'approved' && canImplement && <Button size="sm" onClick={schedule}>Schedule (tomorrow 02:00)</Button>}
                  {sel.status === 'review' && canImplement ? (
                    // Closing requires a post-implementation review outcome; recording it closes the change.
                    <Select
                      aria-label="Post-implementation review outcome"
                      value=""
                      onChange={(e) => e.target.value && recordPir(e.target.value)}
                    >
                      <option value="">Record PIR &amp; close…</option>
                      <option value="successful">Successful</option>
                      <option value="partial">Partial</option>
                      <option value="failed">Failed</option>
                      <option value="rolled_back">Rolled back</option>
                    </Select>
                  ) : (
                    nextImpl[sel.status] && canImplement && <Button size="sm" variant="subtle" onClick={() => advance(nextImpl[sel.status])}>Advance to {nextImpl[sel.status]}</Button>
                  )}
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>
      )}
    </div>
  );
}

const riskBar = (r: string) => (r === 'high' ? 'bg-danger' : r === 'medium' ? 'bg-warning' : 'bg-brand');

/** Month-grid change calendar backed by GET /changes/calendar (scheduled + implementing). */
function ChangeCalendar({ onOpen }: { onOpen: (id: string) => void }) {
  const [month, setMonth] = React.useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [items, setItems] = React.useState<Change[] | null>(null);

  React.useEffect(() => {
    const from = new Date(month.getFullYear(), month.getMonth(), 1);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    setItems(null);
    api
      .get<{ data: Change[] }>(`/changes/calendar?from=${from.toISOString()}&to=${to.toISOString()}`)
      .then((r) => setItems(r.data))
      .catch(() => setItems([]));
  }, [month]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay()); // back to the Sunday on/before the 1st
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const today = new Date();
  const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const changesOn = (day: Date) =>
    (items ?? []).filter((c) => {
      if (!c.window_start) return false;
      const s = new Date(c.window_start);
      const e = c.window_end ? new Date(c.window_end) : s;
      const d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const d1 = new Date(d0);
      d1.setDate(d0.getDate() + 1);
      return s < d1 && e >= d0;
    });

  const monthLabel = month.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <Card>
      <CardHeader>
        <div className="flex w-full items-center justify-between">
          <CardTitle>{monthLabel}</CardTitle>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
            <Button size="sm" variant="subtle" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</Button>
            <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {items === null ? (
          <Skeleton className="h-72" />
        ) : (
          <>
            <div className="grid grid-cols-7 gap-px border-b border-border pb-1 text-center text-[11px] font-semibold uppercase tracking-wider text-muted">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-px overflow-hidden rounded-md bg-border">
              {days.map((day, i) => {
                const inMonth = day.getMonth() === month.getMonth();
                const dayChanges = changesOn(day);
                return (
                  <div key={i} className={`min-h-[92px] bg-surface p-1 ${inMonth ? '' : 'opacity-45'}`}>
                    <div className={`mb-0.5 text-right text-[11px] ${isSameDay(day, today) ? 'font-bold text-brand' : 'text-muted'}`}>{day.getDate()}</div>
                    <div className="space-y-0.5">
                      {dayChanges.slice(0, 3).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => onOpen(c.id)}
                          title={`${c.title} — ${c.risk} risk, ${c.status}`}
                          className="flex w-full items-center gap-1 truncate rounded bg-surface-2 px-1 py-0.5 text-left text-[10px] text-fg hover:bg-surface-2/70"
                        >
                          <span className={`h-2 w-1 shrink-0 rounded-sm ${riskBar(c.risk)}`} />
                          <span className="truncate">{c.window_start ? new Date(c.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} {c.title}</span>
                        </button>
                      ))}
                      {dayChanges.length > 3 && <div className="px-1 text-[10px] text-muted">+{dayChanges.length - 3} more</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-4 text-[11px] text-muted">
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('high')}`} /> High</span>
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('medium')}`} /> Medium</span>
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('low')}`} /> Low</span>
              <span className="ml-auto">Scheduled &amp; implementing changes</span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
