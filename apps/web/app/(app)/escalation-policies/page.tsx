'use client';
import React from 'react';
import { escalationApi, type EscalationPolicy } from '@/lib/api';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Select, Input, Field } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

function stepSummary(steps: EscalationPolicy['steps']): string {
  return steps
    .map((s) => `${s.targetType}@${s.delayMinutes}m`)
    .join(' → ');
}

export default function EscalationPoliciesPage() {
  const { can, me } = useAuth();
  const [rows, setRows] = React.useState<EscalationPolicy[] | null>(null);
  const load = React.useCallback(() => { setRows(null); escalationApi.list().then(setRows).catch(() => setRows([])); }, []);
  React.useEffect(() => { load(); }, [load]);
  const canManage = can('escalation.manage');
  const [creating, setCreating] = React.useState(false);
  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const isAgent = me?.plane === 'nexus';
  React.useEffect(() => { if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {}); }, [isAgent]);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Escalation policies</h1><p className="mt-1 text-sm text-muted">Multi-step routing for unacknowledged pages and alerts.</p></div>
        {canManage && <Button onClick={() => setCreating(true)}>New policy</Button>}
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<EscalationPolicy>
            rows={rows}
            columns={[
              { key: 'name', header: 'Name', render: (p) => p.name },
              { key: 'steps', header: 'Steps', render: (p) => p.steps.length },
              { key: 'summary', header: 'Routing', render: (p) => <span className="text-xs text-muted">{stepSummary(p.steps)}</span> },
            ]}
            empty={<EmptyState title="No escalation policies" />}
          />
        )}
      </CardBody></Card>
      {creating && (
        <NewPolicyModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
      )}
    </div>
  );
}

interface StepDraft { targetType: 'schedule' | 'user'; targetId: string; delayMinutes: number; }

function NewPolicyModal({ orgs, isAgent, onClose, onCreated }: { orgs: { id: string; name: string }[]; isAgent: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [steps, setSteps] = React.useState<StepDraft[]>([{ targetType: 'schedule', targetId: '', delayMinutes: 0 }]);
  const [err, setErr] = React.useState('');

  function addStep() { setSteps((s) => [...s, { targetType: 'user', targetId: '', delayMinutes: 0 }]); }
  function removeStep(i: number) { setSteps((s) => s.filter((_, idx) => idx !== i)); }
  function updateStep<K extends keyof StepDraft>(i: number, key: K, value: StepDraft[K]) {
    setSteps((s) => s.map((st, idx) => idx === i ? { ...st, [key]: value } : st));
  }

  async function save() {
    try {
      await escalationApi.create({ name, steps, ...(isAgent ? { organizationId } : {}) });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <Dialog title="New escalation policy" onClose={onClose} size="lg">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Critical alert policy" /></Field>
          {isAgent && (
            <Field label="Organization">
              <Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
                <option value="">Select…</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
          )}
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Steps</div>
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={step.targetType} onChange={(e) => updateStep(i, 'targetType', e.target.value as 'schedule' | 'user')} className="w-28">
                  <option value="schedule">Schedule</option>
                  <option value="user">User</option>
                </Select>
                <Input value={step.targetId} onChange={(e) => updateStep(i, 'targetId', e.target.value)} placeholder="ID" className="flex-1" />
                <Input type="number" min={0} value={step.delayMinutes} onChange={(e) => updateStep(i, 'delayMinutes', Number(e.target.value))} className="w-20" />
                <span className="text-xs text-muted">min</span>
                {steps.length > 1 && <Button size="sm" variant="outline" onClick={() => removeStep(i)}>−</Button>}
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={addStep}>+ Add step</Button>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={!name || (isAgent && !organizationId) || steps.some((s) => !s.targetId)}>Create</Button>
          </div>
    </Dialog>
  );
}
