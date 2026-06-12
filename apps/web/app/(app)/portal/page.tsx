'use client';
// Customer support portal / help center — the customer's friendly home for raising
// and tracking requests. Intentionally lighter and more welcoming than the agent
// control plane.
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, catalog, type Ticket, type CatalogItem, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Input, Textarea, Select, Field, Badge } from '@/components/ui/primitives';
import { StatusBadge, PriorityBadge } from '@/components/ui/badges';
import { EmptyState, Skeleton } from '@/components/ui/data';
import DisplayCards from '@/components/ui/display-cards';
import { UserMinus, ShieldAlert, AlertTriangle } from 'lucide-react';

const stackBase =
  "before:absolute before:w-[100%] before:outline-1 before:rounded-xl before:outline-border before:h-[100%] before:content-[''] before:bg-blend-overlay before:bg-background/50 grayscale-[100%] hover:before:opacity-0 before:transition-opacity before:duration-700 hover:grayscale-0 before:left-0 before:top-0";

// Featured-services showcase cards for the portal hero (stacked display-cards).
const FEATURED_CARDS = [
  {
    icon: <UserMinus className="size-4 text-blue-300" />,
    title: 'Offboarding',
    description: 'M365 — Offboard departing user',
    date: '2-hour response',
    className: `[grid-area:stack] hover:-translate-y-10 ${stackBase}`,
  },
  {
    icon: <ShieldAlert className="size-4 text-blue-300" />,
    title: 'Security',
    description: 'Report a security incident',
    date: '15-min · 24×7',
    className: `[grid-area:stack] translate-x-16 translate-y-10 hover:-translate-y-1 ${stackBase}`,
  },
  {
    icon: <AlertTriangle className="size-4 text-blue-300" />,
    title: 'Outage',
    description: 'Report a service outage',
    date: '15-min · 24×7',
    className: '[grid-area:stack] translate-x-32 translate-y-20 hover:translate-y-10',
  },
];

const TYPE_OPTIONS = [
  { value: 'incident', label: 'Something is broken' },
  { value: 'service_request', label: 'I need something' },
  { value: 'access_request', label: 'Access / account help' },
  { value: 'customer_question', label: 'I have a question' },
];

export default function PortalPage() {
  const { me } = useAuth();
  const router = useRouter();
  const firstName = (me?.email ?? '').split('@')[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase());

  const [tickets, setTickets] = React.useState<Ticket[] | null>(null);
  const [items, setItems] = React.useState<CatalogItem[]>([]);
  const [query, setQuery] = React.useState('');
  const [kbHits, setKbHits] = React.useState<Array<{ id: string; title: string; snippet: string }>>([]);

  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?limit=8').then((r) => setTickets(r.data)).catch(() => setTickets([]));
    catalog.list().then((r) => setItems(r.data)).catch(() => {});
  }, []);

  // Debounced knowledge-base search so the box surfaces real self-service answers (KB
  // articles), not just catalog item names.
  React.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setKbHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ data: Array<{ id: string; title: string; snippet: string }> }>(`/kb/search?q=${encodeURIComponent(q)}`)
        .then((r) => setKbHits(r.data))
        .catch(() => setKbHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const open = (tickets ?? []).filter((t) => !['resolved', 'closed'].includes(t.status));
  const filteredCatalog = items.filter((i) => !query || i.name.toLowerCase().includes(query.toLowerCase()) || i.category.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-12">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-surface to-surface-2 px-8 py-12 text-center">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-brand/15 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 bottom-0 h-56 w-56 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">How can we help{firstName ? `, ${firstName}` : ''}?</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted">
            Submit a request and our support team will take it from here. Track everything in one place.
          </p>
          <div className="mx-auto mt-6 flex max-w-md items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search common requests…"
              className="h-11"
            />
          </div>
          {query.trim() && (
            <div className="mx-auto mt-3 max-w-md overflow-hidden rounded-xl border border-border bg-surface text-left shadow-lg">
              {kbHits.length > 0 && (
                <div className="border-b border-border p-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Knowledge base</div>
                  {kbHits.slice(0, 4).map((h) => (
                    <Link key={h.id} href="/kb" className="block rounded-md px-2 py-1.5 hover:bg-surface-2">
                      <div className="text-sm font-medium text-fg">{h.title}</div>
                      {h.snippet && (
                        <div className="mt-0.5 text-xs text-muted [&_b]:font-medium [&_b]:text-brand" dangerouslySetInnerHTML={{ __html: h.snippet }} />
                      )}
                    </Link>
                  ))}
                </div>
              )}
              {filteredCatalog.length > 0 && (
                <div className="p-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Request something</div>
                  {filteredCatalog.slice(0, 4).map((i) => (
                    <Link key={i.key} href="/catalog" className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-2">
                      <span className="text-sm text-fg">{i.name}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-muted">{i.category}</span>
                    </Link>
                  ))}
                </div>
              )}
              {kbHits.length === 0 && filteredCatalog.length === 0 && (
                <div className="p-4 text-center text-xs text-muted">
                  No matches for “{query.trim()}”.{' '}
                  <Link href="/tickets/new" className="text-brand hover:underline">Submit a request →</Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Featured services showcase */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Featured services</h2>
          <Link href="/catalog" className="text-xs text-brand hover:underline">Browse catalog →</Link>
        </div>
        <div className="flex min-h-[20rem] w-full items-center justify-center">
          <DisplayCards cards={FEATURED_CARDS} />
        </div>
      </section>

      {/* Submit + popular */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <QuickSubmit onCreated={(t) => router.push(`/tickets/${t.id}`)} />
        </div>
        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardBody>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg">Popular requests</h3>
                <Link href="/catalog" className="text-xs text-brand hover:underline">All services →</Link>
              </div>
              <div className="space-y-2">
                {items.slice(0, 5).map((i) => (
                  <Link
                    key={i.key}
                    href="/catalog"
                    className="flex items-center justify-between rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 transition hover:border-brand/40 hover:bg-surface-2"
                  >
                    <div>
                      <div className="text-xs font-medium text-fg">{i.name}</div>
                      <div className="text-[10px] text-muted">{i.category}</div>
                    </div>
                    <span className="text-muted">→</span>
                  </Link>
                ))}
                {items.length === 0 && <p className="text-xs text-muted">Loading services…</p>}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* My requests */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Your requests</h2>
          <Link href="/tickets" className="text-xs text-brand hover:underline">View all →</Link>
        </div>
        {!tickets ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : tickets.length === 0 ? (
          <Card><CardBody><EmptyState title="No requests yet" description="When you submit a request it’ll show up here so you can track its progress." /></CardBody></Card>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => (
              <Link key={t.id} href={`/tickets/${t.id}`}>
                <Card className="transition-transform hover:-translate-y-0.5">
                  <CardBody className="flex flex-wrap items-center gap-3 py-3.5">
                    <span className="font-mono text-xs text-muted">{t.ticket_number}</span>
                    <span className="flex-1 text-sm font-medium text-fg">{t.subject}</span>
                    <PriorityBadge priority={t.priority} />
                    <StatusBadge status={t.status} />
                    <span className="text-xs text-muted">{new Date(t.created_at).toLocaleDateString()}</span>
                  </CardBody>
                </Card>
              </Link>
            ))}
          </div>
        )}
        {tickets && open.length > 0 && (
          <p className="mt-3 text-center text-xs text-muted">
            {open.length} open · we’ll email you when there’s an update.
          </p>
        )}
      </div>
    </div>
  );
}

function QuickSubmit({ onCreated }: { onCreated: (t: Ticket) => void }) {
  const [type, setType] = React.useState('incident');
  const [subject, setSubject] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<Ticket>('/tickets', { type, subject, description });
      onCreated(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not submit your request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">Submit a request</h3>
          <Badge tone="success">we’re here to help</Badge>
        </div>
        <p className="mb-4 text-xs text-muted">Tell us what’s going on and we’ll route it to the right team.</p>
        <form onSubmit={submit}>
          <Field label="What do you need?">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Briefly, what’s the issue?" required minLength={3} maxLength={300} />
          </Field>
          <Field label="Details">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened, what you expected, and any error messages…" />
          </Field>
          {error && <p className="mb-3 text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</Button>
            <Link href="/catalog" className="text-xs text-muted hover:text-fg">or browse the service catalog →</Link>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
