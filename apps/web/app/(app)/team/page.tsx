'use client';
// Platform User Administration — administer nexus (staff) accounts and their organization
// scope. A global admin (SuperAdmin) can scope an admin to specific orgs or all orgs.
import React from 'react';
import { platformUsersApi, customersApi, type PlatformUser, type OrgSummary, type OrgScope, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Card, CardBody, Input, Badge } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function TeamPage() {
  const { can } = useAuth();
  const canManage = can('admin.users.manage');
  const isSuper = can('admin.superuser');

  const [users, setUsers] = React.useState<PlatformUser[] | null>(null);
  const [assignable, setAssignable] = React.useState<string[]>([]);
  const [orgs, setOrgs] = React.useState<OrgSummary[]>([]);
  const [editing, setEditing] = React.useState<PlatformUser | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    platformUsersApi.list().then((r) => { setUsers(r.data); setAssignable(r.assignable_roles); }).catch(() => setUsers([]));
  }, []);
  React.useEffect(() => {
    refresh();
    customersApi.list().then(setOrgs).catch(() => setOrgs([]));
  }, [refresh]);

  const orgName = React.useCallback((id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8), [orgs]);

  if (!canManage) {
    return <EmptyState title="Access denied" description="You need the platform user-administration permission to view this page." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Platform users</h1>
          <p className="mt-1 text-sm text-muted">Staff accounts and the organizations each can see. {isSuper ? 'You can grant all-orgs scope and the SuperAdmin role.' : 'You can manage users within your own organization scope.'}</p>
        </div>
        <Button onClick={() => { setErr(null); setCreating(true); }}>New platform user</Button>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}

      <Card><CardBody>
        {users === null ? <Skeleton className="h-12" /> : (
          <DataTable<PlatformUser>
            rows={users}
            columns={[
              { key: 'name', header: 'User', render: (u) => (
                <button className="text-left text-brand hover:underline" onClick={() => { setErr(null); setEditing(u); }}>
                  <div className="font-medium">{u.display_name ?? u.email}</div>
                  <div className="text-xs text-muted">{u.email}</div>
                </button>
              ) },
              { key: 'roles', header: 'Roles', render: (u) => u.roles.length ? u.roles.map((r) => <Badge key={r} tone={r === 'SuperAdmin' ? 'danger' : 'brand'} className="mr-1">{r}</Badge>) : <span className="text-muted">—</span> },
              { key: 'scope', header: 'Organization scope', render: (u) => u.all_orgs
                ? <Badge tone="warning">All organizations</Badge>
                : u.org_ids.length
                  ? <span className="text-sm">{u.org_ids.length === 1 ? orgName(u.org_ids[0]) : `${u.org_ids.length} orgs`}</span>
                  : <span className="text-muted">No orgs</span> },
              { key: 'signin', header: 'Sign-in', render: (u) => u.has_password ? <Badge tone="neutral">local + SSO</Badge> : <Badge tone="neutral">SSO only</Badge> },
              { key: 'status', header: 'Status', render: (u) => <Badge tone={u.status === 'active' ? 'success' : 'warning'}>{u.status}</Badge> },
            ]}
            empty={<EmptyState title="No platform users" />}
          />
        )}
      </CardBody></Card>

      {creating && (
        <UserModal
          mode="create"
          assignable={assignable}
          orgs={orgs}
          isSuper={isSuper}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); refresh(); }}
          onError={setErr}
        />
      )}
      {editing && (
        <UserModal
          mode="edit"
          user={editing}
          assignable={assignable}
          orgs={orgs}
          isSuper={isSuper}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
          onError={setErr}
        />
      )}
    </div>
  );
}

function UserModal({
  mode, user, assignable, orgs, isSuper, onClose, onSaved, onError,
}: {
  mode: 'create' | 'edit';
  user?: PlatformUser;
  assignable: string[];
  orgs: OrgSummary[];
  isSuper: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = React.useState(user?.email ?? '');
  const [displayName, setDisplayName] = React.useState(user?.display_name ?? '');
  const [password, setPassword] = React.useState('');
  const [roles, setRoles] = React.useState<string[]>(user?.roles ?? ['Tier1']);
  const [scopeMode, setScopeMode] = React.useState<'all' | 'orgs'>(user?.all_orgs ? 'all' : 'orgs');
  const [orgIds, setOrgIds] = React.useState<string[]>(user?.org_ids ?? []);
  const [status, setStatus] = React.useState<'active' | 'suspended'>((user?.status as 'active' | 'suspended') ?? 'active');
  const [busy, setBusy] = React.useState(false);

  const scope: OrgScope = scopeMode === 'all' ? { mode: 'all' } : { mode: 'orgs', orgIds };
  const toggleRole = (r: string) => setRoles((s) => s.includes(r) ? s.filter((x) => x !== r) : [...s, r]);
  const toggleOrg = (id: string) => setOrgIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  async function save() {
    setBusy(true);
    try {
      if (mode === 'create') {
        await platformUsersApi.create({
          email: email.trim(),
          displayName: displayName.trim() || undefined,
          roleKeys: roles,
          password: password.trim() || undefined,
          scope,
        });
      } else if (user) {
        await platformUsersApi.update(user.id, {
          status,
          displayName: displayName.trim() || undefined,
          password: password.trim() || undefined,
        });
        await platformUsersApi.setRoles(user.id, roles);
        await platformUsersApi.setScope(user.id, scope);
      }
      onSaved();
    } catch (e) { onError(e instanceof ApiError ? e.detail : 'Save failed'); onClose(); }
    finally { setBusy(false); }
  }

  return (
    <Dialog title={mode === 'create' ? 'New platform user' : (user?.display_name ?? user?.email ?? 'Edit user')} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted">Email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@nexus.example" disabled={mode === 'edit'} />
        </div>
        <div>
          <label className="text-xs text-muted">Display name</label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
        </div>
      </div>

      <div>
        <label className="text-xs text-muted">{mode === 'create' ? 'Local password (optional — enables email/password sign-in)' : 'Reset local password (optional)'}</label>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 10 characters" />
      </div>

      {mode === 'edit' && (
        <div>
          <label className="text-xs text-muted">Status</label>
          <div className="flex gap-2">
            {(['active', 'suspended'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={`rounded-md border px-3 py-1 text-sm ${status === s ? 'border-brand bg-brand/10 text-fg' : 'border-border text-muted'}`}>{s}</button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-fg">Roles</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {assignable.map((r) => (
            <label key={r} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${roles.includes(r) ? 'border-brand bg-brand/10 text-fg' : 'border-border text-muted'}`}>
              <input type="checkbox" className="accent-[var(--brand,#4f46e5)]" checked={roles.includes(r)} onChange={() => toggleRole(r)} />
              {r}
            </label>
          ))}
        </div>
        {!isSuper && <p className="mt-1 text-[11px] text-muted">Only a SuperAdmin can grant the SuperAdmin role.</p>}
      </div>

      <div>
        <div className="text-xs font-semibold text-fg">Organization scope</div>
        <div className="mt-1 flex gap-3 text-sm">
          <label className={`flex items-center gap-1.5 ${!isSuper ? 'opacity-50' : ''}`}>
            <input type="radio" name="scope" checked={scopeMode === 'all'} disabled={!isSuper} onChange={() => setScopeMode('all')} />
            All organizations
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="scope" checked={scopeMode === 'orgs'} onChange={() => setScopeMode('orgs')} />
            Specific organizations
          </label>
        </div>
        {!isSuper && <p className="mt-1 text-[11px] text-muted">Only a SuperAdmin can grant all-organizations scope.</p>}
        {scopeMode === 'orgs' && (
          <div className="mt-2 max-h-44 space-y-1 overflow-auto rounded-md border border-border p-2">
            {orgs.length === 0 ? <p className="text-xs text-muted">No organizations.</p> : orgs.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={orgIds.includes(o.id)} onChange={() => toggleOrg(o.id)} />
                {o.name}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy || !email.includes('@') || roles.length === 0 || (scopeMode === 'orgs' && orgIds.length === 0)}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </Dialog>
  );
}

