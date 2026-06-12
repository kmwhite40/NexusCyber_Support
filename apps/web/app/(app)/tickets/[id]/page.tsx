'use client';
import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, oncall, ApiError, type Ticket, TIER_GROUPS } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Textarea, Badge, Select } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge, SlaBadge } from '@/components/ui/badges';

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
  const nextStates: Record<string, string[]> = {
    new: ['assigned'], triage: ['assigned', 'in_progress'], assigned: ['in_progress'],
    in_progress: ['waiting_customer', 'resolved'], waiting_customer: ['in_progress', 'resolved'],
    resolved: ['closed', 'reopened'], reopened: ['in_progress'],
  };

  return (
    <div className="space-y-5">
      <button onClick={() => router.push('/tickets')} className="text-xs text-muted hover:text-fg">← Back to tickets</button>

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
                {paged ? 'Paged ✓' : 'Page on-call'}
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
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${
                        t.status === 'done' ? 'border-success text-success' : t.status === 'skipped' ? 'border-muted text-muted' : 'border-border text-muted'
                      }`}
                    >
                      {t.status === 'done' ? '✓' : t.status === 'skipped' ? '–' : t.position + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-fg">{t.label}</div>
                      <div className="text-[10px] text-muted">{t.assignee_role}{t.automatable ? ' · automatable' : ''}</div>
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

          <Card>
            <CardHeader><CardTitle>Description</CardTitle></CardHeader>
            <CardBody><p className="whitespace-pre-wrap text-sm text-fg/90">{ticket.description || 'No description provided.'}</p></CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {(ticket.comments ?? []).length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
              {(ticket.comments ?? []).map((c) => (
                <div key={c.id} className={`rounded-md border p-3 ${c.visibility === 'internal' ? 'border-warning/30 bg-warning/5' : 'border-border bg-surface-2/40'}`}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-medium text-fg">{c.author_id === me?.id ? 'You' : c.visibility === 'internal' ? 'Agent (internal)' : 'Participant'}</span>
                    {c.visibility === 'internal' && <Badge tone="warning">internal note</Badge>}
                    <span className="ml-auto text-[11px] text-muted">{new Date(c.created_at).toLocaleString()}</span>
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
                    <div className="text-[11px] text-muted">Due {new Date(s.due_at).toLocaleString()}</div>
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
                    <div className="text-[11px] text-muted">{new Date(e.created_at).toLocaleString()}</div>
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
