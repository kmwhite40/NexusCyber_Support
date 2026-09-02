'use client';
import * as React from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Input, Select, Textarea, SegmentedControl } from '@/components/ui/primitives';
import { changesApi, type Change, type ChangeRecord } from '@/lib/changes';
import { ChangeCalendar } from './_components/change-calendar';
import { ChangeList } from './_components/change-list';
import { ChangeDetail } from './_components/change-detail';
import { CabBoardSettings, useOrgOptions } from './_components/cab-board-settings';

type View = 'list' | 'calendar' | 'settings';

export default function ChangesPage() {
  const { me, can } = useAuth();
  const [rows, setRows] = React.useState<Change[] | null>(null);
  const [sel, setSel] = React.useState<ChangeRecord | null>(null);
  const [view, setView] = React.useState<View>('list');
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ title: '', changeType: 'normal', risk: 'medium', description: '' });
  const [err, setErr] = React.useState<string | null>(null);

  const perms = {
    create: can('change.create'),
    vote: can('change.vote'),
    implement: can('change.implement'),
  };
  const canManageCab = can('cab.manage');

  // CAB config is per organization. A customer admin configures their own org and gets no
  // picker; a nexus admin chooses which customer's board they are editing. Neither ever
  // omits the org — see the ORG SCOPE note in _components/cab-board-settings.tsx.
  const isAgent = me?.plane === 'nexus';
  const orgOptions = useOrgOptions(canManageCab && isAgent);
  const [cabOrgId, setCabOrgId] = React.useState<string | null>(null);
  const settingsOrgId = isAgent ? cabOrgId : me?.organization_id ?? null;

  // Losing cab.manage (a role change mid-session) must not strand the user on a tab they
  // may no longer see.
  React.useEffect(() => {
    if (view === 'settings' && !canManageCab) setView('list');
  }, [view, canManageCab]);

  const load = React.useCallback(() => {
    changesApi.list().then(setRows).catch(() => setRows([]));
  }, []);
  React.useEffect(load, [load]);

  const open = React.useCallback((id: string) => {
    changesApi.get(id).then(setSel).catch(() => {});
  }, []);

  /** Re-read the open change and the list after any mutation. */
  const refresh = React.useCallback(() => {
    if (sel) open(sel.id);
    load();
  }, [sel, open, load]);

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

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Change management</h1>
          <p className="mt-1 text-sm text-muted">Standard, normal, and emergency changes with CAB approval and a change calendar.</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<View>
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'calendar', label: 'Calendar' },
              ...(canManageCab ? ([{ value: 'settings' as const, label: 'CAB settings' }]) : []),
            ]}
          />
          {perms.create && view !== 'settings' && (
            <Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'New change'}</Button>
          )}
        </div>
      </div>

      {creating && view !== 'settings' && (
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

      {view === 'settings' && canManageCab && (
        <CabBoardSettings
          organizationId={settingsOrgId}
          orgOptions={isAgent ? orgOptions : []}
          onOrganizationChange={setCabOrgId}
          canListPlatformUsers={can('admin.users.manage')}
        />
      )}

      {view === 'list' && (
        <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
          <ChangeList rows={rows} onOpen={open} />
          <ChangeDetail change={sel} meId={me?.id} perms={perms} onChanged={refresh} />
        </div>
      )}
    </div>
  );
}
