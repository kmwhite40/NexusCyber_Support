'use client';
import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, oncall, ApiError, type Ticket, TIER_GROUPS, LINK_TYPES } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Input, Textarea, Badge, Select } from '@/components/ui/primitives';
import { ArrowLeft, Check, Minus, Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge, SlaBadge } from '@/components/ui/badges';
import { TicketAttachments } from '@/components/ticket-attachments';
import { ProvisioningPanel } from '@/components/provisioning-panel';

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, can } = useAuth();
  const [ticket, setTicket] = React.useState<Ticket | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState('');
  const [visibility, setVisibility] = React.useState<'customer' | 'internal'>('customer');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    api.get<Ticket>(`/tickets/${id}`).then(setTicket).catch((e) => setError(e instanceof ApiError ? e.detail : 'Not found'));
  }, [id]);
  React.useEffect(load, [load]);

  async function addComment() {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await api.post(`/tickets/${id}/comments`, { body: comment, visibility });
      setComment('');
      load();
    } finally {
      setBusy(false);
    }
  }

  async function transition(to: string) {
    setBusy(true);
    try {
      await api.post(`/tickets/${id}/transition`, { to, resolutionCode: to === 'resolved' ? 'fixed' : undefined });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Transition failed');
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true);
    try {
      await api.post(`/tickets/${id}/assign`, { assignedAgentId: me?.id });
      load();
    } finally {
      setBusy(false);
    }
  }

  const [escTarget, setEscTarget] = React.useState(TIER_GROUPS[1]);
  async function escalate() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tickets/${id}/escalate`, { targetGroup: escTarget });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Escalation failed');
    } finally {
      setBusy(false);
    }
  }

  async function completeTask(taskId: string) {
    setBusy(true);
    try {
      await api.post(`/tickets/${id}/tasks/${taskId}/complete`, {});
      load();
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await api.post(`/tickets/${id}/approve`, { approve });
      load();
    } finally {
      setBusy(false);
    }
  }

  const [paged, setPaged] = React.useState(false);
  async function pageOnCall() {
    if (!ticket) return;
    setBusy(true);
    try {
      await oncall.createPage({ ticketId: id, organizationId: ticket.organization_id, severity: ticket.priority === 'P1' ? 'Sev1' : 'Sev2' });
      setPaged(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Paging failed');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Card><CardBody><p className="text-sm text-danger">{error}</p></CardBody></Card>;
  if (!ticket) return <div className="space-y-3"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-64" /></div>;

  const isAgent = me?.plane === 'nexus';
  const tasks = ticket.tasks ?? [];
  const pendingApproval = ticket.approvals?.find((a) => a.status === 'requested');
  const canApprove = can('customer.admin.manage_users') || can('ticket.assign');
  // Provisioning writes to a live directory, so the panel only appears once this ticket's
  // approvals have actually passed. This is presentation, NOT the control: the same rule is
  // enforced in the provisioning service (apps/api/src/modules/provisioning/index.ts), because
  // a hidden button is not an authorization check — the execute endpoint is reachable without
  // this page. Mirrored here so the panel matches what the server will accept.
  //
  // "No approvals at all" is NOT passed: user.provisioning is a requires_approval catalog item,
  // so a request with no approval record did not come through that intake, and the server
  // refuses it. The previous rule said the opposite and would have offered a button that
  // always failed.
  const approvalsPassed = Boolean(ticket.approvals?.length)
    && ticket.approvals!.every((a) => a.status === 'approved');
  const nextStates: Record<string, string[]> = {
    new: ['assigned'], triage: ['assigned', 'in_progress'], assigned: ['in_progress'],
    in_progress: ['waiting_customer', 'resolved'], waiting_customer: ['in_progress', 'resolved'],
    resolved: ['closed', 'reopened'], reopened: ['in_progress'],
  };

  return (
    <div className="space-y-5">
      <button onClick={() => router.push('/tickets')} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" strokeWidth={1.75} /> Back to tickets</button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-xs text-muted">{ticket.ticket_number}</span>
            <PriorityBadge priority={ticket.priority} />
            <StatusBadge status={ticket.status} />
            {ticket.tags?.includes('security') && <Badge tone="danger">security</Badge>}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{ticket.subject}</h1>
        </div>
        {isAgent && can('ticket.update') && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={claim} disabled={busy}>Claim</Button>
            {can('oncall.page') && (
              <Button size="sm" variant="danger" onClick={pageOnCall} disabled={busy || paged}>
                {paged ? <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" strokeWidth={1.75} /> Paged</span> : 'Page on-call'}
              </Button>
            )}
            {(nextStates[ticket.status] ?? []).map((s) => (
              <Button key={s} size="sm" variant={s === 'resolved' ? 'default' : 'subtle'} onClick={() => transition(s)} disabled={busy}>
                {s.replace(/_/g, ' ')}
              </Button>
            ))}
          </div>
        )}
      </div>

      <CsatPrompt ticketId={id} status={ticket.status} />

      {/* Approval gate (service requests) */}
      {pendingApproval && (
        <Card className="border-warning/40">
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <Badge tone="warning">approval required</Badge>
              <span className="text-muted">This service request is pending approval before fulfillment.</span>
            </div>
            {canApprove && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decide(true)} disabled={busy}>Approve</Button>
                <Button size="sm" variant="danger" onClick={() => decide(false)} disabled={busy}>Reject</Button>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Escalate = reassign ownership to a tier (single accountable owner) */}
      {isAgent && can('ticket.escalate') && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted">Escalate (reassigns ownership to a tier):</span>
            <Select className="h-9 w-64" value={escTarget} onChange={(e) => setEscTarget(e.target.value)}>
              {TIER_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
            </Select>
            <Button size="sm" variant="subtle" onClick={escalate} disabled={busy}>Escalate</Button>
          </CardBody>
        </Card>
      )}

      {approvalsPassed && <ProvisioningPanel ticketId={id} canProvision={can('provisioning.execute')} />}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Conversation */}
        <div className="space-y-5 lg:col-span-2">
          {tasks.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Fulfillment workflow</CardTitle></CardHeader>
              <CardBody className="space-y-2">
                {tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-md border border-border bg-surface-2/40 px-3 py-2">
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-xs ${
                        t.status === 'done' ? 'border-success text-success' : t.status === 'skipped' ? 'border-muted text-muted' : 'border-border text-muted'
                      }`}
                    >
                      {t.status === 'done' ? <Check className="h-3 w-3" strokeWidth={1.75} /> : t.status === 'skipped' ? <Minus className="h-3 w-3" strokeWidth={1.75} /> : t.position + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-fg">{t.label}</div>
                      <div className="text-xs text-muted">{t.assignee_role}{t.automatable ? ' · automatable' : ''}</div>
                    </div>
                    {t.status === 'pending' && isAgent && can('ticket.update') ? (
                      <Button size="sm" variant="outline" onClick={() => completeTask(t.id)} disabled={busy}>Complete</Button>
                    ) : t.status !== 'pending' ? (
                      <Badge tone={t.status === 'done' ? 'success' : 'neutral'}>{t.status}</Badge>
                    ) : null}
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          <LinkedTickets ticket={ticket} isAgent={isAgent} canUpdate={can('ticket.update')} onChange={load} />

          <Card>
            <CardHeader><CardTitle>Description</CardTitle></CardHeader>
            <CardBody><p className="whitespace-pre-wrap text-sm text-fg/90">{ticket.description || 'No description provided.'}</p></CardBody>
          </Card>

          <TicketAttachments ticketId={id} />

          <Card>
            <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {(ticket.comments ?? []).length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
              {(ticket.comments ?? []).map((c) => (
                <div key={c.id} className={`rounded-md border p-3 ${c.visibility === 'internal' ? 'border-warning/30 bg-warning/5' : 'border-border bg-surface-2/40'}`}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-medium text-fg">{c.author_id === me?.id ? 'You' : c.visibility === 'internal' ? 'Agent (internal)' : 'Participant'}</span>
                    {c.visibility === 'internal' && <Badge tone="warning">internal note</Badge>}
                    <span className="ml-auto text-xs text-muted">{new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-fg/90">{c.body}</p>
                </div>
              ))}

              <div className="pt-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a reply…" />
                <div className="mt-2 flex items-center gap-2">
                  {isAgent && (
                    <Select className="h-9 w-40" value={visibility} onChange={(e) => setVisibility(e.target.value as any)}>
                      <option value="customer">Customer-visible</option>
                      <option value="internal">Internal note</option>
                    </Select>
                  )}
                  <Button size="sm" onClick={addComment} disabled={busy || !comment.trim()} className="ml-auto">Send</Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Side rail */}
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>SLA</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {(ticket.slas ?? []).length === 0 && <p className="text-sm text-muted">No SLA timers.</p>}
              {(ticket.slas ?? []).map((s) => (
                <div key={s.id} className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium capitalize text-fg">{s.metric}</div>
                    <div className="text-xs text-muted">Due {new Date(s.due_at).toLocaleString()}</div>
                  </div>
                  <SlaBadge state={s.state} />
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <Row k="Type" v={ticket.type.replace(/_/g, ' ')} />
              <Row k="Priority" v={ticket.priority} />
              <Row k="Status" v={ticket.status.replace(/_/g, ' ')} />
              <Row k="Created" v={new Date(ticket.created_at).toLocaleString()} />
              {ticket.tags?.length ? <Row k="Tags" v={ticket.tags.join(', ')} /> : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardBody>
              <ol className="relative space-y-3 border-l border-border pl-4">
                {(ticket.events ?? []).map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand" />
                    <div className="text-xs font-medium text-fg">{e.event_type.replace(/_/g, ' ')}</div>
                    <div className="text-xs text-muted">{new Date(e.created_at).toLocaleString()}</div>
                  </li>
                ))}
                {(ticket.events ?? []).length === 0 && <li className="text-xs text-muted">No events.</li>}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted">{k}</span>
      <span className="text-right text-xs font-medium text-fg">{v}</span>
    </div>
  );
}

function LinkedTickets({ ticket, isAgent, canUpdate, onChange }: { ticket: Ticket; isAgent: boolean; canUpdate: boolean; onChange: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [number, setNumber] = React.useState('');
  const [linkType, setLinkType] = React.useState<string>(LINK_TYPES[0]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const linksList = ticket.links ?? [];

  async function addLink() {
    setBusy(true); setErr(null);
    try {
      // Resolve the target ticket by its human number within the same org's queue.
      const res = await api.get<{ data: Ticket[] }>(`/tickets?limit=500`);
      const target = res.data.find((t) => t.ticket_number.toLowerCase() === number.trim().toLowerCase());
      if (!target) throw new ApiError(404, `No ticket numbered ${number}`);
      await api.post(`/tickets/${ticket.id}/links`, { toTicketId: target.id, linkType });
      setNumber(''); setOpen(false); onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to link');
    } finally { setBusy(false); }
  }

  async function removeLink(linkId: string) {
    await api.del(`/tickets/${ticket.id}/links/${linkId}`).catch(() => {});
    onChange();
  }

  if (linksList.length === 0 && !isAgent) return null;
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border p-4">
        <CardTitle>Linked tickets</CardTitle>
        {isAgent && canUpdate && <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Link a ticket'}</Button>}
      </div>
      <CardBody className="space-y-2">
        {open && (
          <div className="space-y-2 rounded-md border border-border bg-surface-2/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select className="h-9 w-40" value={linkType} onChange={(e) => setLinkType(e.target.value)}>
                {LINK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </Select>
              <Input
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="Ticket number (e.g. ACME-000002)"
                className="h-9 flex-1"
              />
              <Button size="sm" onClick={addLink} disabled={busy || !number.trim()}>Link</Button>
            </div>
            {err && <p className="text-xs text-danger">{err}</p>}
          </div>
        )}
        {linksList.length === 0 ? (
          <p className="text-sm text-muted">No linked tickets.</p>
        ) : (
          linksList.map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border border-border bg-surface-2/40 px-3 py-2">
              <Badge tone="neutral">{l.label}</Badge>
              <span className="font-mono text-xs text-muted">{l.other_number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{l.other_subject}</span>
              {isAgent && canUpdate && <button onClick={() => removeLink(l.id)} className="text-xs text-muted hover:text-danger">remove</button>}
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

function CsatPrompt({ ticketId, status }: { ticketId: string; status: string }) {
  const [state, setState] = React.useState<{ ratable: boolean; rated: boolean } | null>(null);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [hover, setHover] = React.useState(0);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Only resolved/closed tickets are ratable; ask the server who may rate + whether done.
    if (status !== 'resolved' && status !== 'closed') { setState({ ratable: false, rated: false }); return; }
    api.get<{ ratable: boolean; rated: boolean; score: number | null }>(`/csat/ticket/${ticketId}`)
      .then((r) => setState({ ratable: r.ratable, rated: r.rated }))
      .catch(() => setState({ ratable: false, rated: false }));
  }, [ticketId, status]);

  async function rate(score: number) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/csat/ticket/${ticketId}/respond`, { score });
      setDone(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Could not submit your rating — please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null; // still loading
  if (!state.ratable && !state.rated) return null; // not resolved, or viewer is not the requester
  const finished = done || state.rated;
  return (
    <Card className="border-brand/40">
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        {finished ? (
          <span className="text-sm text-success">Thanks for your feedback!</span>
        ) : (
          <>
            <span className="text-sm text-fg">How satisfied were you with the resolution?</span>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1 ${busy ? 'opacity-50' : ''}`} onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={busy}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => rate(n)}
                    className={`transition-colors ${n <= hover ? 'text-warning' : 'text-muted hover:text-warning/70'}`}
                    aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  >
                    <Star className="h-5 w-5" strokeWidth={1.75} fill={n <= hover ? 'currentColor' : 'none'} />
                  </button>
                ))}
              </div>
              {err && <span className="text-xs text-danger">{err}</span>}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
