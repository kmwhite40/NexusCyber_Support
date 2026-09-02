'use client';
import * as React from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Textarea, SegmentedControl } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/data';
import { changesApi, statusTone, type Change, type ChangeRecord } from '@/lib/changes';
import { ChangeCalendar } from './_components/change-calendar';
import { ChangeList } from './_components/change-list';

export default function ChangesPage() {
  const { me, can } = useAuth();
  const [rows, setRows] = React.useState<Change[] | null>(null);
  const [sel, setSel] = React.useState<ChangeRecord | null>(null);
  const [view, setView] = React.useState<'list' | 'calendar'>('list');
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ title: '', changeType: 'normal', risk: 'medium', description: '' });
  const [err, setErr] = React.useState<string | null>(null);

  const canVote = can('change.vote');
  const canImplement = can('change.implement');

  const load = React.useCallback(() => {
    changesApi.list().then(setRows).catch(() => setRows([]));
  }, []);
  React.useEffect(load, [load]);

  function open(id: string) {
    changesApi.get(id).then(setSel).catch(() => {});
  }

  async function create() {
    setErr(null);
    try {
      const c = await changesApi.create(form);
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
      await changesApi.submitCab(sel.id);
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
      await changesApi.vote(sel.id, vote);
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
    await changesApi.schedule(sel.id, start.toISOString(), end.toISOString()).catch(() => {});
    open(sel.id); load();
  }
  async function recordPir(outcome: string) {
    if (!sel) return;
    await changesApi.pir(sel.id, outcome as 'successful' | 'partial' | 'failed' | 'rolled_back').catch(() => {});
    open(sel.id); load();
  }
  async function advance(to: string) {
    if (!sel) return;
    await changesApi.transition(sel.id, to as 'implementing' | 'review' | 'closed').catch(() => {});
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
        <ChangeList rows={rows} onOpen={open} />

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
                    <Badge tone={statusTone(sel.status)}>{sel.status.replace(/_/g, ' ')}</Badge>
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
