'use client';
import React from 'react';
import {
  servicesApi, CI_REL_TYPES,
  type ServiceRow, type ConfigurationItem, type ConfigurationItemDetail, type CiRelType, type CiRelationship, ApiError,
} from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Badge, Button, Input, Select, Label, SegmentedControl } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { X } from 'lucide-react';

const CRITICALITY_LABEL: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const REL_LABEL: Record<CiRelType, string> = {
  depends_on: 'depends on', runs_on: 'runs on', hosts: 'hosts', connects_to: 'connects to', member_of: 'member of', uses: 'uses',
};

export default function ServicesPage() {
  const [tab, setTab] = React.useState<'services' | 'cis'>('services');
  const [services, setServices] = React.useState<ServiceRow[] | null>(null);
  const [cis, setCis] = React.useState<ConfigurationItem[] | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const loadCis = React.useCallback(() => { servicesApi.cis().then(setCis).catch(() => setCis([])); }, []);
  React.useEffect(() => {
    servicesApi.list().then(setServices).catch(() => setServices([]));
    loadCis();
  }, [loadCis]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services &amp; assets</h1>
        <p className="mt-1 text-sm text-muted">Service registry and configuration items (CMDB) with attributes and relationships.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Services" value={services?.length ?? '—'} />
        <StatCard label="Configuration items" value={cis?.length ?? '—'} />
      </div>
      <SegmentedControl<'services' | 'cis'>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'services', label: 'Services' },
          { value: 'cis', label: 'Configuration items' },
        ]}
      />
      <Card>
        <CardBody>
          {tab === 'services' ? (
            services === null ? <Skeleton className="h-12" /> : (
              <DataTable<ServiceRow>
                rows={services}
                columns={[
                  { key: 'name', header: 'Service', render: (s) => s.name },
                  { key: 'kind', header: 'Kind', render: (s) => <Badge>{s.kind}</Badge> },
                  { key: 'ticket_count', header: 'Tickets', render: (s) => s.ticket_count },
                ]}
                empty={<EmptyState title="No services registered" />}
              />
            )
          ) : cis === null ? <Skeleton className="h-12" /> : (
            <DataTable<ConfigurationItem>
              rows={cis}
              onRowClick={(c) => setOpenId(c.id)}
              columns={[
                { key: 'name', header: 'CI', render: (c) => <span className="font-medium text-brand">{c.name}</span> },
                { key: 'ci_class', header: 'Class', render: (c) => <Badge>{c.ci_class}</Badge> },
                { key: 'criticality', header: 'Criticality', render: (c) => CRITICALITY_LABEL[c.criticality] ?? String(c.criticality) },
                { key: 'owner', header: 'Owner', render: (c) => c.owner ?? <span className="text-muted">—</span> },
                { key: 'status', header: 'Status', render: (c) => c.status },
                { key: 'ticket_count', header: 'Tickets', render: (c) => c.ticket_count },
              ]}
              empty={<EmptyState title="No configuration items" />}
            />
          )}
        </CardBody>
      </Card>

      {openId && (
        <CiDetailModal
          id={openId}
          allCis={cis ?? []}
          onClose={() => setOpenId(null)}
          onChanged={loadCis}
        />
      )}
    </div>
  );
}

function CiDetailModal({ id, allCis, onClose, onChanged }: { id: string; allCis: ConfigurationItem[]; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const canManage = can('service.manage');
  const [ci, setCi] = React.useState<ConfigurationItemDetail | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [owner, setOwner] = React.useState('');
  const [supportGroup, setSupportGroup] = React.useState('');
  const [status, setStatus] = React.useState('active');
  const [criticality, setCriticality] = React.useState('2');
  const [attrs, setAttrs] = React.useState<Array<[string, string]>>([]);
  const [busy, setBusy] = React.useState(false);

  // add-relationship form
  const [relType, setRelType] = React.useState<CiRelType>('depends_on');
  const [targetId, setTargetId] = React.useState('');

  const load = React.useCallback(() => {
    servicesApi.ci(id).then((d) => {
      setCi(d);
      setOwner(d.owner ?? ''); setSupportGroup(d.support_group ?? '');
      setStatus(d.status); setCriticality(String(d.criticality));
      setAttrs(Object.entries(d.attributes ?? {}).map(([k, v]) => [k, String(v)]));
    }).catch(() => setErr('Failed to load CI.'));
  }, [id]);
  React.useEffect(load, [load]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const attributes = Object.fromEntries(attrs.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      await servicesApi.updateCi(id, { owner: owner.trim() || null, supportGroup: supportGroup.trim() || null, status, criticality, attributes });
      onChanged(); load();
    } catch (e) { setErr(e instanceof ApiError ? e.detail : 'Save failed'); }
    finally { setBusy(false); }
  }
  async function addRel() {
    if (!targetId) return;
    setBusy(true); setErr(null);
    try { await servicesApi.addRel({ sourceId: id, targetId, relType }); setTargetId(''); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.detail : 'Add relationship failed'); }
    finally { setBusy(false); }
  }
  async function removeRel(relId: string) {
    try { await servicesApi.removeRel(relId); load(); } catch (e) { setErr(e instanceof ApiError ? e.detail : 'Remove failed'); }
  }

  const otherCis = allCis.filter((c) => c.id !== id);
  const RelRow = ({ r, dir }: { r: CiRelationship; dir: 'out' | 'in' }) => (
    <div className="flex items-center justify-between rounded border border-border px-2 py-1 text-xs">
      <span>{dir === 'out' ? <>this <span className="text-muted">{REL_LABEL[r.rel_type]}</span> <span className="font-medium text-fg">{r.name}</span></> : <><span className="font-medium text-fg">{r.name}</span> <span className="text-muted">{REL_LABEL[r.rel_type]}</span> this</>} <Badge tone="neutral">{r.ci_class}</Badge></span>
      {canManage && <button onClick={() => removeRel(r.id)} aria-label="Remove relationship" className="ml-2 text-muted hover:text-danger"><X className="h-4 w-4" strokeWidth={1.75} /></button>}
    </div>
  );

  return (
    <Dialog title={ci?.name ?? "Configuration item"} onClose={onClose} size="xl">
          {err && <p className="text-sm text-danger">{err}</p>}
          {!ci ? <Skeleton className="h-40" /> : (
            <>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{ci.name}</h2>
                <Badge>{ci.ci_class}</Badge>
                <span className="ml-auto text-xs text-muted">{ci.ticket_count} ticket(s)</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div><Label className="font-normal">Owner</Label><Input value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!canManage} placeholder="unassigned" /></div>
                <div><Label className="font-normal">Support group</Label><Input value={supportGroup} onChange={(e) => setSupportGroup(e.target.value)} disabled={!canManage} placeholder="unassigned" /></div>
                <div><Label className="font-normal">Criticality</Label>
                  <Select value={criticality} onChange={(e) => setCriticality(e.target.value)} disabled={!canManage}>
                    {[['4', 'Critical'], ['3', 'High'], ['2', 'Medium'], ['1', 'Low']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </div>
                <div><Label className="font-normal">Status</Label>
                  <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={!canManage}>
                    {['active', 'maintenance', 'retired'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </div>
              </div>

              {/* Attributes (extensible key/value) */}
              <div>
                <div className="mb-1 text-xs font-semibold text-fg">Attributes</div>
                <div className="space-y-1">
                  {attrs.map(([k, v], i) => (
                    <div key={i} className="flex gap-2">
                      <Input className="w-1/3" value={k} placeholder="key" disabled={!canManage} onChange={(e) => setAttrs((a) => a.map((p, j) => j === i ? [e.target.value, p[1]] : p))} />
                      <Input className="flex-1" value={v} placeholder="value" disabled={!canManage} onChange={(e) => setAttrs((a) => a.map((p, j) => j === i ? [p[0], e.target.value] : p))} />
                      {canManage && <button onClick={() => setAttrs((a) => a.filter((_, j) => j !== i))} aria-label="Remove attribute" className="px-1 text-muted hover:text-danger"><X className="h-4 w-4" strokeWidth={1.75} /></button>}
                    </div>
                  ))}
                  {attrs.length === 0 && <p className="text-xs text-muted">No attributes.</p>}
                  {canManage && <Button size="sm" variant="outline" onClick={() => setAttrs((a) => [...a, ['', '']])}>+ Attribute</Button>}
                </div>
              </div>

              {/* Relationships */}
              <div>
                <div className="mb-1 text-xs font-semibold text-fg">Relationships</div>
                <div className="space-y-1">
                  {ci.relationships.outgoing.map((r) => <RelRow key={r.id} r={r} dir="out" />)}
                  {ci.relationships.incoming.map((r) => <RelRow key={r.id} r={r} dir="in" />)}
                  {ci.relationships.outgoing.length === 0 && ci.relationships.incoming.length === 0 && <p className="text-xs text-muted">No relationships.</p>}
                </div>
                {canManage && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">this</span>
                    <Select className="w-36" value={relType} onChange={(e) => setRelType(e.target.value as CiRelType)}>
                      {CI_REL_TYPES.map((r) => <option key={r} value={r}>{REL_LABEL[r]}</option>)}
                    </Select>
                    <Select className="flex-1" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                      <option value="">Select a CI…</option>
                      {otherCis.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.ci_class})</option>)}
                    </Select>
                    <Button size="sm" onClick={addRel} disabled={busy || !targetId}>Link</Button>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
                {canManage && <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}
              </div>
            </>
          )}
    </Dialog>
  );
}
