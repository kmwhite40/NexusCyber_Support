'use client';
import * as React from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Textarea } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

interface Problem {
  id: string; title: string; status: string; priority: string;
  known_error: boolean; incident_count: number; root_cause: string | null; workaround: string | null;
}
interface ProblemDetail extends Problem { description: string | null; incidents: Array<{ id: string; ticket_number: string; subject: string; status: string }> }
interface Candidate { key: string; count: number; ticketIds: string[]; sampleSubject: string }

const tone = (s: string) => (s === 'resolved' || s === 'closed' ? 'success' : s === 'known_error' ? 'warning' : 'neutral');
const nextStatus: Record<string, string[]> = {
  open: ['investigating'], investigating: ['known_error', 'resolved'], known_error: ['resolved'], resolved: ['closed'], closed: [],
};

export default function ProblemsPage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Problem[] | null>(null);
  const [cands, setCands] = React.useState<Candidate[]>([]);
  const [sel, setSel] = React.useState<ProblemDetail | null>(null);
  const [title, setTitle] = React.useState('');
  const [edit, setEdit] = React.useState({ rootCause: '', workaround: '' });

  const canManage = can('problem.manage');

  const load = React.useCallback(() => {
    api.get<{ data: Problem[] }>('/problems').then((r) => setRows(r.data)).catch(() => setRows([]));
    api.get<{ data: Candidate[] }>('/problems/candidates').then((r) => setCands(r.data)).catch(() => setCands([]));
  }, []);
  React.useEffect(load, [load]);

  function open(id: string) {
    api.get<ProblemDetail>(`/problems/${id}`).then((p) => { setSel(p); setEdit({ rootCause: p.root_cause ?? '', workaround: p.workaround ?? '' }); }).catch(() => {});
  }
  async function create() {
    if (!title.trim()) return;
    const p = await api.post<Problem>('/problems', { title });
    setTitle(''); load(); open(p.id);
  }
  async function saveEdit(knownError?: boolean) {
    if (!sel) return;
    await api.patch(`/problems/${sel.id}`, { ...edit, knownError: knownError ?? sel.known_error });
    open(sel.id); load();
  }
  async function advance(to: string) {
    if (!sel) return;
    await api.post(`/problems/${sel.id}/transition`, { to });
    open(sel.id); load();
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Problem management</h1>
        <p className="mt-1 text-sm text-muted">Track root causes behind recurring incidents; capture known errors and workarounds.</p>
      </div>

      {canManage && cands.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader><CardTitle>Candidate problems (recurring incidents)</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            {cands.map((c) => (
              <div key={c.key} className="flex items-center justify-between rounded-md border border-border bg-surface-2/40 px-3 py-2">
                <div className="text-sm text-fg/90"><span className="font-medium capitalize">{c.key}</span> · {c.count} open incidents · e.g. “{c.sampleSubject}”</div>
                <Button size="sm" variant="outline" onClick={() => { setTitle(`Recurring: ${c.key}`); }}>Draft problem</Button>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card>
          <div className="flex items-center justify-between border-b border-border p-4">
            <CardTitle>Problems</CardTitle>
            {canManage && (
              <div className="flex gap-2">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New problem title" className="w-56" />
                <Button size="sm" onClick={create} disabled={!title.trim()}>Create</Button>
              </div>
            )}
          </div>
          <CardBody className="px-0 pt-0">
            {!rows ? (
              <div className="space-y-2 p-5">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              <DataTable<Problem>
                rows={rows}
                onRowClick={(p) => open(p.id)}
                empty={<EmptyState title="No problems" description="Create a problem or promote a candidate cluster." />}
                columns={[
                  { key: 'title', header: 'Problem', render: (p) => <span className="font-medium text-fg">{p.title}</span> },
                  { key: 'ke', header: 'Known error', render: (p) => p.known_error ? <Badge tone="warning">known error</Badge> : <span className="text-xs text-muted">—</span> },
                  { key: 'inc', header: 'Incidents', render: (p) => <span className="tabular-nums text-xs text-muted">{p.incident_count}</span> },
                  { key: 'status', header: 'Status', render: (p) => <Badge tone={tone(p.status) as any}>{p.status.replace(/_/g, ' ')}</Badge> },
                ]}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{sel ? 'Problem detail' : 'Select a problem'}</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            {!sel ? (
              <EmptyState title="Nothing selected" description="Pick a problem from the list." />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{sel.title}</span>
                  <Badge tone={tone(sel.status) as any}>{sel.status.replace(/_/g, ' ')}</Badge>
                </div>
                {canManage ? (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted">Root cause</label>
                    <Textarea value={edit.rootCause} onChange={(e) => setEdit({ ...edit, rootCause: e.target.value })} rows={2} />
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted">Workaround</label>
                    <Textarea value={edit.workaround} onChange={(e) => setEdit({ ...edit, workaround: e.target.value })} rows={2} />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => saveEdit()}>Save</Button>
                      {!sel.known_error && <Button size="sm" variant="outline" onClick={() => saveEdit(true)}>Mark known error</Button>}
                      {(nextStatus[sel.status] ?? []).map((s) => <Button key={s} size="sm" variant="subtle" onClick={() => advance(s)}>{s.replace(/_/g, ' ')}</Button>)}
                    </div>
                  </div>
                ) : (
                  <>
                    {sel.root_cause && <p className="text-xs text-fg/80"><span className="text-muted">Root cause:</span> {sel.root_cause}</p>}
                    {sel.workaround && <p className="text-xs text-fg/80"><span className="text-muted">Workaround:</span> {sel.workaround}</p>}
                  </>
                )}
                <div className="border-t border-border pt-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Linked incidents ({sel.incidents.length})</div>
                  {sel.incidents.length === 0 ? <p className="text-xs text-muted">None linked.</p> : sel.incidents.map((i) => (
                    <div key={i.id} className="flex items-center gap-2 py-1 text-xs">
                      <span className="font-mono text-muted">{i.ticket_number}</span>
                      <span className="min-w-0 flex-1 truncate text-fg/90">{i.subject}</span>
                      <Badge tone="neutral">{i.status}</Badge>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
