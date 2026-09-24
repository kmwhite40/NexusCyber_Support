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
  const { can, me } = useAuth();
  const canManage = can('admin.users.manage');
  const isSuper = can('admin.superuser');

  const [users, setUsers] = React.useState<PlatformUser[] | null>(null);
  const [assignable, setAssignable] = React.useState<string[]>([]);
  const [orgs, setOrgs] = React.useState<OrgSummary[]>([]);
  const [editing, setEditing] = React.useState<PlatformUser | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

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
      {notice && <p className="text-sm text-success">{notice}</p>}

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
              { key: 'signin', header: 'Sign-in', render: (u) => (
                <span className="flex flex-wrap gap-1">
                  {u.sso_linked ? <Badge tone="success">Entra linked</Badge> : <Badge tone="neutral">SSO not yet used</Badge>}
                  {u.has_password && <Badge tone="warning">local password</Badge>}
                </span>
              ) },
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
          onSaved={(msg) => { setCreating(false); setErr(null); setNotice(msg ?? null); refresh(); }}
        />
      )}
      {editing && (
        <UserModal
          mode="edit"
          user={editing}
          assignable={assignable}
          orgs={orgs}
          isSuper={isSuper}
          isSelf={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); setErr(null); setNotice(msg ?? null); refresh(); }}
        />
      )}
    </div>
  );
}

function UserModal({
  mode, user, assignable, orgs, isSuper, isSelf = false, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  user?: PlatformUser;
  assignable: string[];
  orgs: OrgSummary[];
  isSuper: boolean;
  isSelf?: boolean;
  onClose: () => void;
  onSaved: (message?: string) => void;
}) {
  const [email, setEmail] = React.useState(user?.email ?? '');
  const [displayName, setDisplayName] = React.useState(user?.display_name ?? '');
  const [password, setPassword] = React.useState('');
  const [roles, setRoles] = React.useState<string[]>(user?.roles ?? ['Tier1']);
  const [scopeMode, setScopeMode] = React.useState<'all' | 'orgs'>(user?.all_orgs ? 'all' : 'orgs');
  const [orgIds, setOrgIds] = React.useState<string[]>(user?.org_ids ?? []);
  const [status, setStatus] = React.useState<'active' | 'suspended'>((user?.status as 'active' | 'suspended') ?? 'active');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const scope: OrgScope = scopeMode === 'all' ? { mode: 'all' } : { mode: 'orgs', orgIds };
  const toggleRole = (r: string) => setRoles((s) => s.includes(r) ? s.filter((x) => x !== r) : [...s, r]);
  const toggleOrg = (id: string) => setOrgIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create') {
        const r = await platformUsersApi.create({
          email: email.trim(),
          displayName: displayName.trim() || undefined,
          roleKeys: roles,
          password: password.trim() || undefined,
          scope,
        });
        onSaved(r.releasedCustomerAccount
          ? `Created. ${email.trim()} also had a customer-portal account; it was suspended and its Microsoft sign-in moved to this staff account.`
          : undefined);
      } else if (user) {
        // Roles + scope first, in one transaction: if that is refused (e.g. an empty scope),
        // nothing else has changed either.
        await platformUsersApi.setAccess(user.id, roles, scope);
        await platformUsersApi.update(user.id, {
          status,
          displayName: displayName.trim() || undefined,
          password: password.trim() || undefined,
        });
        onSaved();
      }
    } catch (e) {
      // Keep the dialog open with what was typed — closing it threw the edits away.
      setError(e instanceof ApiError ? e.detail : 'Save failed');
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const r = await platformUsersApi.remove(user.id);
      onSaved(r.mode === 'deleted'
        ? `${user.email} was deleted.`
        : `${user.email} was deleted. Their tickets and history are kept under "${user.display_name ?? user.email} (deleted)".`);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Delete failed');
      setConfirmDelete(false);
    } finally { setBusy(false); }
  }

  return (
    <Dialog title={mode === 'create' ? 'New platform user' : (user?.display_name ?? user?.email ?? 'Edit user')} onClose={onClose} size="xl">
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

      {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="flex items-center justify-end gap-2 pt-1">
        {mode === 'edit' && !isSelf && (
          confirmDelete ? (
            <div className="mr-auto flex items-center gap-2 text-sm">
              <span className="text-danger">Delete this account? This can&apos;t be undone.</span>
              <Button variant="danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</Button>
              <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep</Button>
            </div>
          ) : (
            <Button variant="outline" className="mr-auto border-danger/40 text-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete account
            </Button>
          )
        )}
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy || !email.includes('@') || roles.length === 0 || (scopeMode === 'orgs' && orgIds.length === 0)}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </Dialog>
  );
}

