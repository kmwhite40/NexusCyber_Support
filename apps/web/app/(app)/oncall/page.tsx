'use client';
// On-call console (docs/nexus/04-sla-oncall.md §H) — current responder, rotation,
// and active pages with acknowledge / escalate.
import * as React from 'react';
import { oncall, type OnCallSchedule, type OnCallPage, type Responder, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Field } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { Pencil, X } from 'lucide-react';

// In-app replacements for window.confirm / window.prompt / window.alert.
type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; tone: 'default' | 'danger'; onConfirm: () => void }
  | { kind: 'prompt'; title: string; message: string; initial: string; placeholder?: string; onSubmit: (value: string) => void }
  | { kind: 'alert'; title: string; message: string };

function DialogHost({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const [value, setValue] = React.useState(dialog.kind === 'prompt' ? dialog.initial : '');
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader><CardTitle>{dialog.title}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-fg/80">{dialog.message}</p>
          {dialog.kind === 'prompt' && (
            <Input
              autoFocus
              value={value}
              placeholder={dialog.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { dialog.onSubmit(value); onClose(); } }}
            />
          )}
          <div className="flex justify-end gap-2">
            {dialog.kind !== 'alert' && <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>}
            {dialog.kind === 'confirm' && (
              <Button size="sm" variant={dialog.tone === 'danger' ? 'danger' : 'default'} onClick={() => { dialog.onConfirm(); onClose(); }}>{dialog.confirmLabel}</Button>
            )}
            {dialog.kind === 'prompt' && <Button size="sm" onClick={() => { dialog.onSubmit(value); onClose(); }}>Save</Button>}
            {dialog.kind === 'alert' && <Button size="sm" onClick={onClose}>OK</Button>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

export default function OnCallPage() {
  const { can } = useAuth();
  const [schedules, setSchedules] = React.useState<OnCallSchedule[] | null>(null);
  const [pages, setPages] = React.useState<OnCallPage[] | null>(null);
  const [responders, setResponders] = React.useState<Responder[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [config, setConfig] = React.useState<{ mode: 'create' | 'edit' | 'override'; schedule?: OnCallSchedule } | null>(null);
  const [dialog, setDialog] = React.useState<Dialog | null>(null);
  const canManage = can('oncall.manage');

  const load = React.useCallback(() => {
    oncall.schedules().then((r) => setSchedules(r.data)).catch(() => setSchedules([]));
    oncall.pages().then((r) => setPages(r.data)).catch(() => setPages([]));
    if (canManage) oncall.responders().then((r) => setResponders(r.data)).catch(() => {});
  }, [canManage]);
  React.useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      load();
    } finally {
      setBusy(false);
    }
  }

  const open = (pages ?? []).filter((p) => p.state === 'notified' || p.state === 'escalated');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">On-call console</h1>
          <p className="mt-1 text-sm text-muted">Current responders, rotations, and active pages.</p>
        </div>
        <div className="flex gap-2">
          {canManage && <Button variant="outline" onClick={() => setConfig({ mode: 'create' })}>+ New rotation</Button>}
          {can('oncall.page') && (
            <Button onClick={() => act(() => oncall.createPage({ severity: 'Sev2' }))} disabled={busy}>
              Trigger test page
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Open pages" value={pages ? open.length : '—'} tone="danger" />
        <StatCard label="Schedules" value={schedules ? schedules.length : '—'} tone="brand" />
        <StatCard
          label="On call now"
          value={schedules?.[0]?.current?.name?.split(' ')[0] ?? '—'}
          tone="accent"
        />
      </div>

      {/* Schedules */}
      <div className="grid gap-6 lg:grid-cols-2">
        {!schedules ? (
          <Skeleton className="h-48" />
        ) : (
          schedules.map((s) => (
            <Card key={s.id}>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>{s.team}</CardTitle>
                <div className="flex items-center gap-2">
                  {canManage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setConfig({ mode: 'edit', schedule: s })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfig({ mode: 'override', schedule: s })}>Override</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setDialog({
                          kind: 'confirm',
                          title: 'Delete schedule',
                          message: `Delete schedule "${s.team}"? This removes its rotation and responders. Blocked if any page is still open.`,
                          confirmLabel: 'Delete',
                          tone: 'danger',
                          onConfirm: () => {
                            act(() => oncall.deleteSchedule(s.id)).catch((e) => setDialog({ kind: 'alert', title: 'Delete failed', message: e instanceof ApiError ? e.detail : 'Delete failed' }));
                          },
                        })}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  <Badge tone="neutral">{s.coverage}</Badge>
                </div>
              </CardHeader>
              <CardBody>
                <div className="mb-4 flex items-center gap-3 rounded-md border border-brand/30 bg-brand/10 px-4 py-3">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-brand-fg">
                    {(s.current?.name ?? '?').slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-fg">{s.current?.name ?? 'Unassigned'}</div>
                    <div className="text-[11px] text-muted">
                      On call now {s.current?.via === 'override' ? '(override)' : `· ${s.rotationLengthDays}-day rotation`}
                      {s.current?.phone ? ` · ${s.current.phone}` : ''}
                    </div>
                  </div>
                </div>
                <div className="text-xs font-medium text-muted">Rotation</div>
                <ol className="mt-2 space-y-1">
                  {s.participants.map((p) => (
                    <li key={p.position} className="flex items-center gap-2 text-xs">
                      <span className="grid h-5 w-5 place-items-center rounded-full border border-border text-[10px] text-muted">{p.position + 1}</span>
                      <span className={s.current?.name === p.name ? 'font-medium text-brand' : 'text-fg'}>{p.name}</span>
                      {s.current?.name === p.name && <Badge tone="brand">current</Badge>}
                      <span className="ml-auto flex items-center gap-2">
                        {p.phone ? (
                          <span className="tabular-nums text-muted">{p.phone}</span>
                        ) : (
                          <span className="italic text-muted/50">no cell</span>
                        )}
                        {canManage && (
                          <>
                            <button
                              type="button"
                              title="Set cell number"
                              className="text-muted hover:text-fg"
                              disabled={busy}
                              onClick={() => setDialog({
                                kind: 'prompt',
                                title: 'Set cell number',
                                message: `Cell number for ${p.name} (paging contact)`,
                                initial: p.phone ?? '',
                                placeholder: '+1 555 555 5555',
                                onSubmit: (v) => act(() => oncall.setResponderPhone(p.user_id, v.trim() || null)),
                              })}
                            >
                              <Pencil className="h-4 w-4" strokeWidth={1.75} />
                            </button>
                            <button
                              type="button"
                              title="Remove from rotation"
                              className="text-muted hover:text-danger"
                              disabled={busy}
                              onClick={() => setDialog({
                                kind: 'confirm',
                                title: 'Remove responder',
                                message: `Remove ${p.name} from "${s.team}"?`,
                                confirmLabel: 'Remove',
                                tone: 'danger',
                                onConfirm: () => {
                                  act(() => oncall.removeParticipant(s.id, p.user_id)).catch((e) => setDialog({ kind: 'alert', title: 'Remove failed', message: e instanceof ApiError ? e.detail : 'Remove failed' }));
                                },
                              })}
                            >
                              <X className="h-4 w-4" strokeWidth={1.75} />
                            </button>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      {/* Pages */}
      <Card>
        <CardHeader><CardTitle>Pages</CardTitle></CardHeader>
        <CardBody className="px-0 pt-0">
          {!pages ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<OnCallPage>
              rows={pages}
              empty={<EmptyState title="No pages" description="Active and recent pages will appear here." />}
              columns={[
                { key: 'sev', header: 'Severity', render: (p) => <Badge tone={p.severity === 'Sev1' ? 'danger' : 'warning'}>{p.severity}</Badge> },
                { key: 'responder', header: 'Responder', render: (p) => <span className="text-fg">{p.responder ?? '—'}</span> },
                { key: 'org', header: 'Customer', render: (p) => <span className="text-xs text-muted">{p.org ?? '—'}</span> },
                {
                  key: 'state', header: 'State', render: (p) => (
                    <Badge tone={p.state === 'acknowledged' ? 'success' : p.state === 'escalated' ? 'danger' : p.state === 'resolved' ? 'neutral' : 'warning'}>
                      {p.state}
                    </Badge>
                  ),
                },
                { key: 'when', header: 'Created', render: (p) => <span className="text-xs text-muted">{new Date(p.created_at).toLocaleString()}</span> },
                {
                  key: 'act', header: '', render: (p) =>
                    p.state === 'notified' || p.state === 'escalated' ? (
                      <div className="flex gap-2">
                        {can('oncall.acknowledge') && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => oncall.ack(p.id))}>Ack</Button>}
                        {can('oncall.page') && <Button size="sm" variant="subtle" disabled={busy} onClick={() => act(() => oncall.escalatePage(p.id))}>Escalate</Button>}
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {config && (
        <ConfigModal
          mode={config.mode}
          schedule={config.schedule}
          responders={responders}
          onClose={() => setConfig(null)}
          onSaved={() => {
            setConfig(null);
            load();
          }}
        />
      )}

      {dialog && <DialogHost dialog={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ConfigModal({
  mode,
  schedule,
  responders,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit' | 'override';
  schedule?: OnCallSchedule;
  responders: Responder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [team, setTeam] = React.useState(schedule?.team ?? '');
  const [lengthDays, setLengthDays] = React.useState(schedule?.rotationLengthDays ?? 7);
  const [selected, setSelected] = React.useState<string[]>(schedule?.participants.map((p) => p.user_id) ?? []);
  // override fields
  const [ovUser, setOvUser] = React.useState(responders[0]?.id ?? '');
  const [ovStart, setOvStart] = React.useState('');
  const [ovEnd, setOvEnd] = React.useState('');
  const [ovReason, setOvReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create') {
        await oncall.createSchedule({ team, lengthDays, participantIds: selected });
      } else if (mode === 'edit' && schedule) {
        await oncall.updateRotation(schedule.id, { lengthDays, participantIds: selected });
      } else if (mode === 'override' && schedule) {
        await oncall.createOverride({ scheduleId: schedule.id, userId: ovUser, startsAt: new Date(ovStart).toISOString(), endsAt: new Date(ovEnd).toISOString(), reason: ovReason });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'create' ? 'New on-call rotation' : mode === 'edit' ? `Edit rotation — ${schedule?.team}` : `Add override — ${schedule?.team}`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <CardBody>
          <form onSubmit={save}>
            {mode === 'override' ? (
              <>
                <Field label="Who is covering?">
                  <Select value={ovUser} onChange={(e) => setOvUser(e.target.value)}>
                    {responders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="From"><Input type="datetime-local" value={ovStart} onChange={(e) => setOvStart(e.target.value)} required /></Field>
                  <Field label="Until"><Input type="datetime-local" value={ovEnd} onChange={(e) => setOvEnd(e.target.value)} required /></Field>
                </div>
                <Field label="Reason (optional)"><Input value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="PTO, swap…" /></Field>
              </>
            ) : (
              <>
                {mode === 'create' && (
                  <Field label="Team name">
                    <Input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Tier 2 On-Call" required minLength={2} />
                  </Field>
                )}
                <Field label="Rotation length (days)">
                  <Input type="number" min={1} max={90} value={lengthDays} onChange={(e) => setLengthDays(Number(e.target.value))} />
                </Field>
                <Field label={`Responders (in order) — ${selected.length} selected`} hint="Order of selection is the rotation order.">
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {responders.map((r) => {
                      const idx = selected.indexOf(r.id);
                      return (
                        <button
                          type="button"
                          key={r.id}
                          onClick={() => toggle(r.id)}
                          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition ${idx >= 0 ? 'bg-brand/15 text-brand' : 'text-fg hover:bg-surface-2'}`}
                        >
                          <span>{r.name}</span>
                          {idx >= 0 && <span className="grid h-5 w-5 place-items-center rounded-full bg-brand text-[10px] font-bold text-brand-fg">{idx + 1}</span>}
                        </button>
                      );
                    })}
                    {responders.length === 0 && <p className="p-2 text-xs text-muted">No responders available.</p>}
                  </div>
                </Field>
              </>
            )}
            {error && <p className="mb-3 text-xs text-danger">{error}</p>}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy || (mode !== 'override' && selected.length === 0)}>{busy ? 'Saving…' : 'Save'}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
