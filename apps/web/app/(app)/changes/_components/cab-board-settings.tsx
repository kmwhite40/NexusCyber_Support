'use client';
// CAB administration: the standing board (members, chair, quorum, threshold), blackout
// windows, and change templates. Gated on `cab.manage` by the page.
//
// ORG SCOPE — every call names an organization explicitly. On the API side an omitted
// organizationId means the GLOBAL (organization_id IS NULL) row that every tenant
// inherits, which is refused without the platform-wide `cab.manage.global` that only a
// SuperAdmin holds — so an omission here would 403 every ordinary org admin. This screen
// therefore edits per-organization CAB config only; the global defaults are deliberately
// out of reach from it. Global rows still show in the blackout/template lists (orgs
// inherit them) and are labelled as such.
import * as React from 'react';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Input, Select, Textarea, Field } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';
import { ApiError, api, users, platformUsersApi, type UserHit } from '@/lib/api';
import {
  cabApi, type CabBoard, type Blackout, type ChangeTemplate, type Threshold, type ChangeType, type RiskBand,
} from '@/lib/changes';

const THRESHOLDS: ReadonlyArray<{ value: Threshold; label: string }> = [
  { value: 'majority', label: 'Simple majority' },
  { value: 'two_thirds', label: 'Two-thirds' },
  { value: 'unanimous', label: 'Unanimous' },
];

interface Candidate { id: string; label: string }
interface DraftMember { userId: string; role: 'chair' | 'member' }

const labelFor = (id: string, candidates: Candidate[]) =>
  candidates.find((c) => c.id === id)?.label ?? id;

/** ISO string for a `datetime-local` value; '' when the field is empty. */
const localToIso = (v: string) => (v ? new Date(v).toISOString() : '');

export function CabBoardSettings({
  /** The org whose CAB config this edits. Never optional — see the ORG SCOPE note above. */
  organizationId,
  orgOptions,
  onOrganizationChange,
  canListPlatformUsers,
}: {
  organizationId: string | null;
  /** Orgs a nexus-plane admin may pick between; empty for a customer-plane admin. */
  orgOptions: Array<{ id: string; name: string }>;
  onOrganizationChange: (id: string) => void;
  /** Holds admin.users.manage, so the nexus staff directory can be offered as candidates. */
  canListPlatformUsers: boolean;
}) {
  if (!organizationId) {
    return (
      <Card>
        <CardHeader><CardTitle>CAB settings</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {orgOptions.length > 0 ? (
            <Field label="Organization" hint="CAB boards, blackouts and templates are configured per organization.">
              <Select aria-label="Organization" value="" onChange={(e) => onOrganizationChange(e.target.value)}>
                <option value="">Select an organization…</option>
                {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
          ) : (
            <EmptyState title="No organization" description="Your account is not scoped to an organization whose CAB you can configure." />
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {orgOptions.length > 0 && (
        <Card>
          <CardBody>
            <Field label="Organization" hint="CAB boards, blackouts and templates are configured per organization.">
              <Select aria-label="Organization" value={organizationId} onChange={(e) => onOrganizationChange(e.target.value)}>
                {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
          </CardBody>
        </Card>
      )}
      {/* Remounting on org change resets every draft, so a half-edited board cannot be
          saved against a different organization. */}
      <BoardEditor key={`board-${organizationId}`} organizationId={organizationId} canListPlatformUsers={canListPlatformUsers} />
      <BlackoutEditor key={`blackout-${organizationId}`} organizationId={organizationId} />
      <TemplateEditor key={`template-${organizationId}`} organizationId={organizationId} />
    </div>
  );
}

// ---- Standing board ----

function BoardEditor({ organizationId, canListPlatformUsers }: { organizationId: string; canListPlatformUsers: boolean }) {
  const [board, setBoard] = React.useState<CabBoard | null>(null);
  const [members, setMembers] = React.useState<DraftMember[]>([]);
  const [name, setName] = React.useState('Change Advisory Board');
  const [quorum, setQuorum] = React.useState('1');
  const [threshold, setThreshold] = React.useState<Threshold>('majority');
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [query, setQuery] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    cabApi
      .board(organizationId)
      .then((b) => {
        setBoard(b);
        setName(b.name ?? 'Change Advisory Board');
        setQuorum(String(b.quorum ?? 1));
        setThreshold(b.threshold ?? 'majority');
        setMembers((b.members ?? []).map((m) => ({ userId: m.user_id, role: m.role })));
      })
      .catch((e) => setErr(e instanceof ApiError ? e.detail : 'Failed to load the board'));
  }, [organizationId]);

  // Candidate voters. The org's own users come from /users/search; nexus staff (who are
  // org-NULL and so invisible to that search) come from the platform directory when the
  // caller may read it — most CAB voters are staff, so without them the picker is empty.
  React.useEffect(() => {
    let live = true;
    const org = users.search(query, organizationId).then((r) => r.data).catch(() => [] as UserHit[]);
    const staff = canListPlatformUsers
      ? platformUsersApi.list().then((r) => r.data).catch(() => [])
      : Promise.resolve([]);
    Promise.all([org, staff]).then(([o, s]) => {
      if (!live) return;
      const term = query.trim().toLowerCase();
      const merged: Candidate[] = [
        ...o.map((u) => ({ id: u.id, label: u.display_name ?? u.email })),
        ...s
          .filter((u) => !term || (u.display_name ?? '').toLowerCase().includes(term) || u.email.toLowerCase().includes(term))
          .map((u) => ({ id: u.id, label: `${u.display_name ?? u.email} (staff)` })),
      ];
      setCandidates(merged.filter((c, i) => merged.findIndex((x) => x.id === c.id) === i));
    });
    return () => { live = false; };
  }, [query, organizationId, canListPlatformUsers]);

  function addMember(id: string) {
    if (!id || members.some((m) => m.userId === id)) return;
    setMembers([...members, { userId: id, role: members.length === 0 ? 'chair' : 'member' }]);
    setSaved(false);
  }
  function removeMember(id: string) {
    setMembers(members.filter((m) => m.userId !== id));
    setSaved(false);
  }
  function makeChair(id: string) {
    setMembers(members.map((m) => ({ ...m, role: m.userId === id ? 'chair' : 'member' })));
    setSaved(false);
  }

  const quorumNum = Math.max(1, parseInt(quorum || '1', 10) || 1);
  // The API clamps a quorum it cannot reach down to the roster at submit time, which
  // weakens the rule. Say so here, where it can still be fixed, not only in the vote panel.
  const overQuorum = members.length > 0 && quorumNum > members.length;

  async function save() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const chair = members.find((m) => m.role === 'chair');
      const next = await cabApi.saveBoard({
        organizationId,
        name: name.trim() || 'Change Advisory Board',
        quorum: quorumNum,
        threshold,
        chairId: chair?.userId ?? null,
        members: members.map((m) => ({ userId: m.userId, role: m.role })),
      });
      setBoard(next);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to save the board');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Change Advisory Board</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        {!board && !err ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            <Field label="Board name">
              <Input aria-label="Board name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Quorum" hint="Minimum ballots cast before a change can resolve.">
                <Input
                  aria-label="Quorum"
                  type="number"
                  min={1}
                  value={quorum}
                  onChange={(e) => { setQuorum(e.target.value); setSaved(false); }}
                />
              </Field>
              <Field label="Threshold" hint="Applied to cast, non-abstaining votes.">
                <Select aria-label="Threshold" value={threshold} onChange={(e) => { setThreshold(e.target.value as Threshold); setSaved(false); }}>
                  {THRESHOLDS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
            </div>

            {overQuorum && (
              <p className="rounded border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
                A quorum of {quorumNum} cannot be reached by {members.length} member{members.length === 1 ? '' : 's'}.
                Changes submitted to this board will vote at a quorum clamped down to the eligible
                roster — and the raiser is recused from their own change, so the roster is often
                smaller still.
              </p>
            )}

            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Members</div>
              {members.length === 0 ? (
                <p className="text-xs text-muted">No members. A change submitted to an empty board is refused.</p>
              ) : (
                <ul className="space-y-1">
                  {members.map((m) => (
                    <li key={m.userId} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
                      <span className="truncate text-fg">{labelFor(m.userId, candidates)}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {m.role === 'chair' ? (
                          <Badge tone="brand">chair</Badge>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => makeChair(m.userId)}>Make chair</Button>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Remove ${labelFor(m.userId, candidates)}`} onClick={() => removeMember(m.userId)}>
                          Remove
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="Search for a board member"
                placeholder="Search people…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select aria-label="Add a board member" value="" onChange={(e) => addMember(e.target.value)}>
                <option value="">Add a member…</option>
                {candidates
                  .filter((c) => !members.some((m) => m.userId === c.id))
                  .map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </div>

            <div className="flex items-center gap-3">
              <Button size="sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save board'}</Button>
              {saved && <span className="text-xs text-success">Saved.</span>}
            </div>
          </>
        )}
        {err && <p className="text-xs text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}

// ---- Blackout windows ----

function BlackoutEditor({ organizationId }: { organizationId: string }) {
  const [rows, setRows] = React.useState<Blackout[] | null>(null);
  const [form, setForm] = React.useState({ name: '', startsAt: '', endsAt: '', reason: '' });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    cabApi.blackouts(organizationId).then(setRows).catch(() => setRows([]));
  }, [organizationId]);
  React.useEffect(load, [load]);

  const valid = form.name.trim() && form.startsAt && form.endsAt && new Date(form.endsAt) > new Date(form.startsAt);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await cabApi.createBlackout({
        organizationId,
        name: form.name.trim(),
        startsAt: localToIso(form.startsAt),
        endsAt: localToIso(form.endsAt),
        reason: form.reason.trim() || undefined,
      });
      setForm({ name: '', startsAt: '', endsAt: '', reason: '' });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to create the blackout window');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setErr(null);
    try {
      await cabApi.deleteBlackout(id);
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to delete the blackout window');
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Blackout windows</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        {rows === null ? (
          <Skeleton className="h-20" />
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted">No freeze windows configured.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
                <span className="min-w-0">
                  <span className="font-medium text-fg">{b.name}</span>
                  {b.organization_id === null && (
                    <Badge tone="accent" className="ml-2" title="Inherited by every organization; editing it needs platform-wide CAB rights">
                      global
                    </Badge>
                  )}
                  <span className="block text-[11px] text-muted">
                    {new Date(b.starts_at).toLocaleString()} → {new Date(b.ends_at).toLocaleString()}
                    {b.reason ? ` · ${b.reason}` : ''}
                  </span>
                </span>
                <Button size="sm" variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => remove(b.id)}>Delete</Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name"><Input aria-label="Blackout name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Reason"><Input aria-label="Blackout reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <Field label="Starts">
            <Input aria-label="Blackout starts" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </Field>
          <Field label="Ends">
            <Input aria-label="Blackout ends" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </Field>
        </div>
        <Button size="sm" variant="subtle" disabled={busy || !valid} onClick={create}>Add blackout window</Button>
        {err && <p className="text-xs text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}

// ---- Change templates ----

function TemplateEditor({ organizationId }: { organizationId: string }) {
  const [rows, setRows] = React.useState<ChangeTemplate[] | null>(null);
  const [form, setForm] = React.useState({
    name: '', changeType: 'standard' as ChangeType, risk: 'low' as RiskBand,
    description: '', implementationPlan: '', testPlan: '', backoutPlan: '',
  });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    cabApi.templates(organizationId).then(setRows).catch(() => setRows([]));
  }, [organizationId]);
  React.useEffect(load, [load]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await cabApi.createTemplate({
        organizationId,
        name: form.name.trim(),
        changeType: form.changeType,
        risk: form.risk,
        description: form.description.trim() || undefined,
        implementationPlan: form.implementationPlan.trim() || undefined,
        testPlan: form.testPlan.trim() || undefined,
        backoutPlan: form.backoutPlan.trim() || undefined,
      });
      setForm({ ...form, name: '', description: '', implementationPlan: '', testPlan: '', backoutPlan: '' });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to create the template');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setErr(null);
    try {
      await cabApi.deleteTemplate(id);
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to delete the template');
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Change templates</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        {rows === null ? (
          <Skeleton className="h-20" />
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted">No templates configured.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
                <span className="min-w-0">
                  <span className="font-medium text-fg">{t.name}</span>
                  {t.organization_id === null && (
                    <Badge tone="accent" className="ml-2" title="Inherited by every organization; editing it needs platform-wide CAB rights">
                      global
                    </Badge>
                  )}
                  <span className="block text-[11px] text-muted">{t.change_type} · {t.risk} risk</span>
                </span>
                <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => remove(t.id)}>Delete</Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Name"><Input aria-label="Template name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Type">
            <Select aria-label="Template type" value={form.changeType} onChange={(e) => setForm({ ...form, changeType: e.target.value as ChangeType })}>
              <option value="standard">Standard (pre-approved)</option>
              <option value="normal">Normal (CAB)</option>
              <option value="emergency">Emergency</option>
            </Select>
          </Field>
          <Field label="Risk">
            <Select aria-label="Template risk" value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value as RiskBand })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
        </div>
        <Textarea aria-label="Template description" placeholder="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Textarea aria-label="Template implementation plan" placeholder="Implementation plan" rows={2} value={form.implementationPlan} onChange={(e) => setForm({ ...form, implementationPlan: e.target.value })} />
        <Textarea aria-label="Template test plan" placeholder="Test plan" rows={2} value={form.testPlan} onChange={(e) => setForm({ ...form, testPlan: e.target.value })} />
        <Textarea aria-label="Template backout plan" placeholder="Backout plan" rows={2} value={form.backoutPlan} onChange={(e) => setForm({ ...form, backoutPlan: e.target.value })} />
        <Button size="sm" variant="subtle" disabled={busy || !form.name.trim()} onClick={create}>Add template</Button>
        {err && <p className="text-xs text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}

/** Organizations a nexus-plane CAB admin may configure. Unwraps the { data } envelope. */
export function useOrgOptions(enabled: boolean) {
  const [orgs, setOrgs] = React.useState<Array<{ id: string; name: string }>>([]);
  React.useEffect(() => {
    if (!enabled) return;
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/organizations')
      .then((r) => setOrgs(r.data))
      .catch(() => setOrgs([]));
  }, [enabled]);
  return orgs;
}
