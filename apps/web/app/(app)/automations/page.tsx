'use client';
// Automation / workflow engine console — list rules, build a rule, simulate it
// (human-in-the-loop preview), publish (separation-of-duties), enable/disable, and
// inspect executions. See docs/nexus/07-automation-kb-reporting.md (Section M).
import * as React from 'react';
import { automation, type AutomationRule, type SimResult, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Field, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { X, ChevronUp, ChevronDown } from 'lucide-react';

const EVENTS = ['ticket.created', 'ticket.status_changed', 'ticket.priority_changed', 'sla.warning', 'sla.breached', 'posture.finding_created'];
const OPS = ['eq', 'neq', 'in', 'gte', 'lte', 'contains', 'exists'];
const ACTIONS: Array<{ type: string; label: string; field: string | null; gated?: boolean }> = [
  { type: 'add_internal_note', label: 'Add internal note', field: 'text' },
  { type: 'add_tag', label: 'Add tag', field: 'tag' },
  { type: 'escalate_ticket', label: 'Escalate ticket', field: null },
  { type: 'page_oncall', label: 'Page on-call', field: null },
  { type: 'create_posture_finding', label: 'Create posture finding', field: null },
  { type: 'notify_teams_channel', label: 'Notify Teams channel', field: 'channel' },
  { type: 'notify_user', label: 'Notify user', field: 'text', gated: true },
  { type: 'change_status', label: 'Change status', field: 'status', gated: true },
  { type: 'add_comment', label: 'Add public comment', field: 'text', gated: true },
];
function parseVal(v: string, op: string): unknown {
  if (op === 'in') return v.split(',').map((s) => s.trim());
  if (v === '' || isNaN(Number(v))) return v;
  return Number(v);
}

const stateTone = (s: string) => (s === 'published' ? 'success' : s === 'disabled' ? 'neutral' : s === 'testing' ? 'warning' : 'brand');

export default function AutomationsPage() {
  const { can } = useAuth();
  const [rules, setRules] = React.useState<AutomationRule[] | null>(null);
  const [modal, setModal] = React.useState<'create' | null>(null);
  const [sim, setSim] = React.useState<AutomationRule | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const canPublish = can('automation.publish');

  const load = React.useCallback(() => {
    automation.list().then((r) => setRules(r.data)).catch((e) => setError(e instanceof ApiError ? e.detail : 'Failed to load'));
  }, []);
  React.useEffect(load, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  if (error && !rules) return <Card><CardBody><p className="text-sm text-danger">{error}</p></CardBody></Card>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automation rules</h1>
          <p className="mt-1 text-sm text-muted">Event-triggered workflows. Customer-visible actions are gated for human approval.</p>
        </div>
        {can('automation.author') && <Button onClick={() => setModal('create')}>+ New rule</Button>}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <Card>
        <CardBody className="px-0 pt-0">
          {!rules ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<AutomationRule>
              rows={rules}
              empty={<EmptyState title="No automation rules" description="Create a rule to react to events automatically." action={can('automation.author') ? <Button size="sm" onClick={() => setModal('create')}>New rule</Button> : undefined} />}
              columns={[
                { key: 'name', header: 'Rule', render: (r) => <span className="font-medium text-fg">{r.name}</span> },
                { key: 'trigger', header: 'Trigger', render: (r) => <span className="font-mono text-xs text-muted">{r.definition?.trigger?.event}</span> },
                { key: 'actions', header: 'Actions', render: (r) => <span className="text-xs text-muted">{r.definition?.actions?.length ?? 0}</span> },
                { key: 'state', header: 'State', render: (r) => <Badge tone={stateTone(r.state)}>{r.state}</Badge> },
                { key: 'v', header: 'v', render: (r) => <span className="text-xs text-muted">v{r.version}</span> },
                {
                  key: 'ops', header: '', render: (r) => (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setSim(r)}>Simulate</Button>
                      {canPublish && r.state !== 'published' && (
                        <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => act(r.id, () => automation.publish(r.id))}>Publish</Button>
                      )}
                      {canPublish && r.state === 'published' && (
                        <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => act(r.id, () => automation.setState(r.id, 'disabled'))}>Disable</Button>
                      )}
                      {canPublish && r.state === 'disabled' && (
                        <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => act(r.id, () => automation.setState(r.id, 'draft'))}>Re-enable</Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {modal === 'create' && <CreateModal onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />}
      {sim && <SimulateModal rule={sim} onClose={() => setSim(null)} />}
    </div>
  );
}

type CondRow = { field: string; op: string; value: string };
type ActRow = { type: string; param: string };

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState('');
  const [event, setEvent] = React.useState(EVENTS[0]);
  const [match, setMatch] = React.useState<'all' | 'any'>('all');
  const [conds, setConds] = React.useState<CondRow[]>([{ field: 'priority', op: 'eq', value: 'P1' }]);
  const [acts, setActs] = React.useState<ActRow[]>([{ type: 'add_tag', param: 'auto' }]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const setCond = (i: number, patch: Partial<CondRow>) => setConds((c) => c.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setAct = (i: number, patch: Partial<ActRow>) => setActs((a) => a.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveAct = (i: number, dir: -1 | 1) => setActs((a) => {
    const j = i + dir;
    if (j < 0 || j >= a.length) return a;
    const next = [...a];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  function buildDefinition(): AutomationRule['definition'] {
    const rows = conds.filter((c) => c.field.trim()).map((c) => ({
      field: c.field.trim(),
      op: c.op as 'eq',
      ...(c.op === 'exists' ? {} : { value: parseVal(c.value, c.op) }),
    }));
    const conditions = rows.length ? { [match]: rows } : undefined;
    const actions = acts.map((a) => {
      const def = ACTIONS.find((d) => d.type === a.type)!;
      const obj: { type: string; [k: string]: unknown } = { type: a.type };
      if (def.field && a.param.trim()) obj[def.field] = a.param;
      return obj;
    });
    return { trigger: { event }, conditions, actions };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (acts.length === 0) { setError('Add at least one action'); return; }
    setBusy(true);
    setError(null);
    try {
      await automation.create({ name, definition: buildDefinition() });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not create rule');
    } finally {
      setBusy(false);
    }
  }

  const fieldLabel = (t: string) => {
    const f = ACTIONS.find((a) => a.type === t)?.field;
    return f === 'text' ? 'text' : f === 'tag' ? 'tag' : f === 'status' ? 'status' : f === 'channel' ? 'channel' : null;
  };

  return (
    <Dialog title="New automation flow" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tag & escalate P1 incidents" required minLength={3} /></Field>

        {/* TRIGGER */}
        <div className="rounded-md border border-border p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-brand">When (trigger)</div>
          <Select value={event} onChange={(e) => setEvent(e.target.value)}>{EVENTS.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        </div>

        {/* CONDITIONS */}
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">If (conditions)</div>
            <div className="flex items-center gap-1 text-xs">
              match
              <Select className="h-7 w-20" value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')}>
                <option value="all">ALL</option>
                <option value="any">ANY</option>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            {conds.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                <Input value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} placeholder="field (e.g. priority)" />
                <Select className="w-24" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                <Input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="value" disabled={c.op === 'exists'} />
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setConds((x) => x.filter((_, j) => j !== i))} aria-label="Remove condition"><X className="h-4 w-4" strokeWidth={1.75} /></Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => setConds((x) => [...x, { field: '', op: 'eq', value: '' }])}>+ Condition</Button>
            {conds.filter((c) => c.field.trim()).length === 0 && <p className="text-[11px] text-muted">No conditions — the flow runs on every {event}.</p>}
          </div>
        </div>

        {/* ACTIONS (ordered) */}
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-brand">Then (actions, in order)</div>
          <div className="space-y-2">
            {acts.map((a, i) => {
              const fl = fieldLabel(a.type);
              const gated = ACTIONS.find((d) => d.type === a.type)?.gated;
              return (
                <div key={i} className="flex items-center gap-2 rounded border border-border bg-surface-2/30 p-2">
                  <span className="text-xs text-muted">{i + 1}.</span>
                  <Select className="w-52" value={a.type} onChange={(e) => setAct(i, { type: e.target.value })}>
                    {ACTIONS.map((d) => <option key={d.type} value={d.type}>{d.label}{d.gated ? ' (gated)' : ''}</option>)}
                  </Select>
                  {fl && <Input className="flex-1" value={a.param} onChange={(e) => setAct(i, { param: e.target.value })} placeholder={fl} />}
                  {gated && <Badge tone="warning">approval</Badge>}
                  <div className="flex flex-col">
                    <Button type="button" variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveAct(i, -1)} aria-label="Move action up"><ChevronUp className="h-4 w-4" strokeWidth={1.75} /></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveAct(i, 1)} aria-label="Move action down"><ChevronDown className="h-4 w-4" strokeWidth={1.75} /></Button>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setActs((x) => x.filter((_, j) => j !== i))} aria-label="Remove action"><X className="h-4 w-4" strokeWidth={1.75} /></Button>
                </div>
              );
            })}
            <Button type="button" size="sm" variant="outline" onClick={() => setActs((x) => [...x, { type: 'add_tag', param: '' }])}>+ Action</Button>
          </div>
        </div>

        {/* FLOW READ-BACK */}
        <div className="rounded-md border border-border bg-surface-2/40 p-3 text-xs text-fg/80">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Flow</div>
          <div><span className="text-brand">When</span> {event}</div>
          {conds.filter((c) => c.field.trim()).length > 0 && (
            <div><span className="text-brand">if</span> {match === 'all' ? 'ALL of' : 'ANY of'}: {conds.filter((c) => c.field.trim()).map((c) => `${c.field} ${c.op}${c.op === 'exists' ? '' : ' ' + c.value}`).join(match === 'all' ? ' AND ' : ' OR ')}</div>
          )}
          {acts.map((a, i) => <div key={i}><span className="text-brand">then</span> {i + 1}. {ACTIONS.find((d) => d.type === a.type)?.label}{fieldLabel(a.type) && a.param ? ` — “${a.param}”` : ''}</div>)}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-3">
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create as draft'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}

function SimulateModal({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const sample = React.useMemo(() => {
    const base: Record<string, unknown> = { ticket_id: '00000000-0000-0000-0000-000000000000' };
    if (rule.definition.trigger.event.startsWith('ticket')) Object.assign(base, { priority: 'P1', type: 'incident', status: 'in_progress' });
    if (rule.definition.trigger.event.startsWith('sla')) Object.assign(base, { metric: 'resolution', priority: 'P1' });
    if (rule.definition.trigger.event.startsWith('posture')) Object.assign(base, { severity: 'critical', domain: 'identity' });
    return JSON.stringify(base, null, 2);
  }, [rule]);
  const [event, setEvent] = React.useState(sample);
  const [result, setResult] = React.useState<SimResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed = JSON.parse(event);
      const r = await automation.simulate(rule.id, parsed);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Invalid JSON or simulation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Simulate — ${rule.name}`} onClose={onClose}>
      <p className="mb-2 text-xs text-muted">Dry-run against a sample event. No side effects.</p>
      <Textarea value={event} onChange={(e) => setEvent(e.target.value)} className="font-mono text-xs" rows={7} />
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run simulation'}</Button>
        {result && <Badge tone={result.matched ? 'success' : 'neutral'}>{result.matched ? 'conditions matched' : 'no match'}</Badge>}
      </div>
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {result && result.intended_actions.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-muted">Intended actions</div>
          {result.intended_actions.map((a, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
              <span className="font-mono text-fg">{a.action.type}</span>
              <span className="flex gap-2">
                {a.performed && <Badge tone="success">auto-performed</Badge>}
                {a.gated && <Badge tone="warning">needs approval</Badge>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

