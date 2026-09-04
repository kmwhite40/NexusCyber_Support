'use client';
import React from 'react';
import { customersApi, CUSTOMER_ROLES, type OrgSummary, type OrgDetail, type OrgUser, type Cloud, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Card, CardBody, Input, Badge } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

const CLOUDS: Cloud[] = ['commercial', 'gcc', 'gcchigh', 'azgov'];
const sel = 'h-9 rounded-md border border-border bg-surface px-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50';

export default function CustomersPage() {
  const { can } = useAuth();
  const admin = can('org.manage');
  const [orgs, setOrgs] = React.useState<OrgSummary[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => { customersApi.list().then(setOrgs).catch(() => setOrgs([])); }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted">Customer organizations and their users.</p>
        </div>
        {admin && <Button onClick={() => { setErr(null); setCreating(true); }}>New customer</Button>}
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}

      <Card><CardBody>
        {orgs === null ? <Skeleton className="h-12" /> : (
          <DataTable<OrgSummary>
            rows={orgs}
            columns={[
              { key: 'name', header: 'Organization', render: (o) => <button className="text-brand hover:underline" onClick={() => setSelectedId(o.id)}>{o.name}</button> },
              { key: 'cloud', header: 'Cloud', render: (o) => o.cloud ?? '—' },
              { key: 'status', header: 'Status', render: (o) => <Badge tone={o.status === 'active' ? 'success' : 'neutral'}>{o.status ?? 'active'}</Badge> },
              { key: 'sso', header: 'SSO', render: (o) => o.entra_tenant_id ? <Badge tone="brand">onboarded</Badge> : <span className="text-muted">—</span> },
            ]}
            empty={<EmptyState title="No customers" />}
          />
        )}
      </CardBody></Card>

      {creating && (
        <CreateOrgModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
          onError={setErr}
        />
      )}
      {selectedId && (
        <OrgDetailModal
          id={selectedId}
          admin={admin}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function CreateOrgModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (m: string) => void }) {
  const [name, setName] = React.useState('');
  const [cloud, setCloud] = React.useState<Cloud>('gcchigh');
  const [tenant, setTenant] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    setBusy(true);
    try {
      await customersApi.create({ name, cloud, entraTenantId: tenant.trim() || undefined });
      onCreated();
    } catch (e) { onError(e instanceof ApiError ? e.detail : 'Create failed'); onClose(); }
    finally { setBusy(false); }
  }
  return (
    <Dialog title="New customer" onClose={onClose}>
      <label className="text-xs text-muted">Organization name</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme, Inc." />
      <label className="text-xs text-muted">Cloud</label>
      <select aria-label="Cloud" className={sel} value={cloud} onChange={(e) => setCloud(e.target.value as Cloud)}>
        {CLOUDS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <label className="text-xs text-muted">Entra tenant ID (optional — onboards SSO)</label>
      <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} disabled={busy || name.trim().length < 2}>{busy ? 'Creating…' : 'Create'}</Button>
      </div>
    </Dialog>
  );
}

function OrgDetailModal({ id, admin, onClose, onChanged }: { id: string; admin: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = React.useState<OrgDetail | null>(null);
  const [users, setUsers] = React.useState<OrgUser[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [cloud, setCloud] = React.useState<Cloud>('gcchigh');
  const [tenant, setTenant] = React.useState('');
  const [status, setStatus] = React.useState('active');
  const [busy, setBusy] = React.useState(false);

  const loadUsers = React.useCallback(() => { customersApi.users(id).then(setUsers).catch(() => setUsers([])); }, [id]);
  React.useEffect(() => {
    customersApi.get(id).then((d) => {
      setDetail(d); setName(d.name); setCloud((d.cloud as Cloud) ?? 'gcchigh');
      setTenant(d.entra_tenant_id ?? ''); setStatus(d.status ?? 'active');
    }).catch(() => setErr('Failed to load organization.'));
    loadUsers();
  }, [id, loadUsers]);

  const [confirmDelete, setConfirmDelete] = React.useState<{ cascade: boolean; message?: string } | null>(null);

  async function saveOrg() {
    setBusy(true); setErr(null);
    try {
      await customersApi.update(id, { name, cloud, status, entraTenantId: tenant.trim() || null });
      onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.detail : 'Save failed'); }
    finally { setBusy(false); }
  }
  async function removeOrg(force = false) {
    // The confirmation is a Dialog, not window.confirm(). Deleting a tenant and every user in it
    // is the most destructive action in this app, and a native browser alert is the one place the
    // product stops looking like itself — exactly where the user most needs to read carefully.
    if (!force && !confirmDelete) { setConfirmDelete({ cascade: false }); return; }
    setBusy(true); setErr(null);
    try {
      await customersApi.remove(id, force);
      onChanged(); onClose();
    } catch (e) {
      const msg = e instanceof ApiError ? e.detail : 'Delete failed';
      // Org still has users — ask again, naming how many, before cascading.
      if (!force && /user\(s\)/i.test(msg)) setConfirmDelete({ cascade: true, message: msg });
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Dialog title={detail?.name ?? 'Organization'} onClose={onClose} size="xl">
      {err && <p className="text-sm text-danger">{err}</p>}
      {detail === null ? <Skeleton className="h-12" /> : (
        <>
          <div className="flex gap-6 text-sm text-muted">
            <span>Users: <span className="text-fg">{detail.user_count}</span></span>
            <span>Open tickets: <span className="text-fg">{detail.open_tickets}</span></span>
          </div>

          {admin && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="text-xs font-semibold text-fg">Organization settings</div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="text-xs text-muted">Name</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div><label className="text-xs text-muted">Cloud</label><select aria-label="Cloud" className={`${sel} w-full`} value={cloud} onChange={(e) => setCloud(e.target.value as Cloud)}>{CLOUDS.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className="text-xs text-muted">Status</label><select aria-label="Status" className={`${sel} w-full`} value={status} onChange={(e) => setStatus(e.target.value)}>{['active', 'suspended', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
                <div><label className="text-xs text-muted">Entra tenant (SSO)</label><Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="none" /></div>
              </div>
              <div className="flex justify-between pt-1">
                <Button variant="danger" onClick={() => removeOrg()} disabled={busy}>Delete org</Button>
                <Button onClick={saveOrg} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
              </div>
            </div>
          )}

          <UserManager orgId={id} users={users} admin={admin} reload={() => { loadUsers(); onChanged(); }} onError={setErr} />
        </>
      )}
    </Dialog>
      {confirmDelete && (
        <Dialog
          title={confirmDelete.cascade ? 'Delete this organization and its users?' : 'Delete this organization?'}
          onClose={() => setConfirmDelete(null)}
          footer={(
            <>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => { setConfirmDelete(null); removeOrg(true); }}
              >
                {busy ? 'Deleting…' : confirmDelete.cascade ? 'Delete org and users' : 'Delete organization'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            </>
          )}
        >
          <p className="text-sm text-fg">
            <b>{detail?.name}</b> will be removed
            {confirmDelete.cascade ? ` along with its ${detail?.user_count ?? ''} user account(s)` : ''}.
          </p>
          {confirmDelete.message && <p className="text-sm text-muted">{confirmDelete.message}</p>}
          <p className="text-sm text-danger">This cannot be undone.</p>
        </Dialog>
      )}
    </>
  );
}

function UserManager({ orgId, users, admin, reload, onError }: { orgId: string; users: OrgUser[] | null; admin: boolean; reload: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [role, setRole] = React.useState<string>('EndUser');
  const [busy, setBusy] = React.useState(false);

  async function add() {
    setBusy(true);
    try { await customersApi.addUser(orgId, { email: email.trim(), displayName: displayName.trim() || undefined, roleKey: role }); setEmail(''); setDisplayName(''); reload(); }
    catch (e) { onError(e instanceof ApiError ? e.detail : 'Add user failed'); }
    finally { setBusy(false); }
  }
  async function setUserRole(u: OrgUser, roleKey: string) {
    try { await customersApi.updateUser(orgId, u.id, { roleKey }); reload(); } catch (e) { onError(e instanceof ApiError ? e.detail : 'Update failed'); }
  }
  async function toggle(u: OrgUser) {
    const next = u.status === 'suspended' ? 'active' : 'suspended';
    try { await customersApi.updateUser(orgId, u.id, { status: next }); reload(); } catch (e) { onError(e instanceof ApiError ? e.detail : 'Update failed'); }
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-fg">Users</div>
      {users === null ? <Skeleton className="h-10" /> : (
        <DataTable<OrgUser>
          rows={users}
          columns={[
            { key: 'email', header: 'Email', render: (u) => u.email },
            { key: 'display_name', header: 'Name', render: (u) => u.display_name ?? '—' },
            { key: 'role', header: 'Role', render: (u) => admin ? (
              <select aria-label="User role" className={sel} value={u.roles?.[0] ?? ''} onChange={(e) => setUserRole(u, e.target.value)}>
                {!(u.roles?.length) && <option value="">—</option>}
                {CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            ) : (u.roles?.join(', ') || '—') },
            { key: 'status', header: 'Status', render: (u) => <Badge tone={u.status === 'active' ? 'success' : 'warning'}>{u.status}</Badge> },
            ...(admin ? [{ key: 'actions', header: '', render: (u: OrgUser) => (
              <Button variant="outline" onClick={() => toggle(u)}>{u.status === 'suspended' ? 'Activate' : 'Suspend'}</Button>
            ) }] : []),
          ]}
          empty={<EmptyState title="No users" />}
        />
      )}
      {admin && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div><label className="text-xs text-muted">Email</label><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@customer.com" /></div>
          <div><label className="text-xs text-muted">Name</label><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" /></div>
          <div><label className="text-xs text-muted">Role</label><select aria-label="Role" className={`${sel} w-full`} value={role} onChange={(e) => setRole(e.target.value)}>{CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
          <Button onClick={add} disabled={busy || !email.includes('@')}>{busy ? 'Adding…' : 'Add user'}</Button>
        </div>
      )}
    </div>
  );
}

