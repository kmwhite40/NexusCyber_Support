'use client';
// Automation / workflow engine console — list rules, build a rule, simulate it
// (human-in-the-loop preview), publish (separation-of-duties), enable/disable, and
// inspect executions. See docs/nexus/07-automation-kb-reporting.md (Section M).
import * as React from 'react';
import { automation, type AutomationRule, type SimResult, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Field, Textarea } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

const EVENTS = ['ticket.created', 'ticket.status_changed', 'ticket.priority_changed', 'sla.warning', 'sla.breached', 'posture.finding_created'];
const OPS = ['eq', 'neq', 'in', 'gte', 'lte', 'contains', 'exists'];
const ACTIONS = [
  { type: 'add_internal_note', label: 'Add internal note', field: 'text' },
  { type: 'add_tag', label: 'Add tag', field: 'tag' },
  { type: 'escalate_ticket', label: 'Escalate ticket', field: null },
  { type: 'page_oncall', label: 'Page on-call', field: null },
  { type: 'notify_user', label: 'Notify user (gated)', field: 'text' },
];

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

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState('');
  const [event, setEvent] = React.useState(EVENTS[0]);
  const [field, setField] = React.useState('priority');
  const [op, setOp] = React.useState('eq');
  const [value, setValue] = React.useState('P1');
  const [actionType, setActionType] = React.useState(ACTIONS[0].type);
  const [actionValue, setActionValue] = React.useState('Auto: high-priority event — review.');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const actionDef = ACTIONS.find((a) => a.type === actionType)!;

  function buildDefinition(): AutomationRule['definition'] {
    const parsed = op === 'in' ? value.split(',').map((s) => s.trim()) : isNaN(Number(value)) || value === '' ? value : Number(value);
    const conditions = field.trim() ? { all: [{ field: field.trim(), op, ...(op === 'exists' ? {} : { value: parsed }) }] } : undefined;
    const action: { type: string; [k: string]: unknown } = { type: actionType };
    if (actionDef.field) action[actionDef.field] = actionValue;
    return { trigger: { event }, conditions, actions: [action] };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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

  return (
    <Modal title="New automation rule" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tag & note P1 incidents" required minLength={3} /></Field>
        <Field label="When this event happens">
          <Select value={event} onChange={(e) => setEvent(e.target.value)}>{EVENTS.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        </Field>
        <div className="mb-1 text-xs font-medium text-muted">And (optional condition)</div>
        <div className="mb-4 grid grid-cols-3 gap-2">
          <Input value={field} onChange={(e) => setField(e.target.value)} placeholder="field" />
          <Select value={op} onChange={(e) => setOp(e.target.value)}>{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" disabled={op === 'exists'} />
        </div>
        <Field label="Then do">
          <Select value={actionType} onChange={(e) => setActionType(e.target.value)}>{ACTIONS.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}</Select>
        </Field>
        {actionDef.field && (
          <Field label={actionDef.field === 'text' ? 'Note text' : 'Tag'}>
            <Input value={actionValue} onChange={(e) => setActionValue(e.target.value)} />
          </Field>
        )}
        <div className="mb-4 rounded-md border border-border bg-surface-2/40 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Definition preview</div>
          <pre className="overflow-x-auto text-[11px] text-fg/80">{JSON.stringify(buildDefinition(), null, 2)}</pre>
        </div>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <div className="flex gap-3">
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create as draft'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
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
    <Modal title={`Simulate — ${rule.name}`} onClose={onClose}>
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
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <CardBody>{children}</CardBody>
      </Card>
    </div>
  );
}
