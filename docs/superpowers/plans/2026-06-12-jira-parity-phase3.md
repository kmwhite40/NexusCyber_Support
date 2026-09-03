# Jira-Parity Phase 3 Implementation Plan (IA / Nav)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Jira parity on information architecture: a lightweight in-app **Get started** surface, an **Archived work items** view, and a **sidebar restructured into sections** (Work / Operations / Insights / Security) mirroring the Jira nav grouping.

**Architecture:** Frontend-only. Two new `'use client'` pages under `apps/web/app/(app)/`; a `shell.tsx` change adding an optional `section` to `NavItem` and grouping the agent nav under section headers (customer nav unchanged). No API or DB changes. Verified by `npx tsc --noEmit`.

**Tech Stack:** Next.js 14 App Router + Tailwind. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-11-jira-parity-features-design.md` (Phase 3 / nav restructure).

---

## Collision protocol

`shell.tsx` is edited by both this work and the concurrent process. For the nav task: run `git status --short apps/web/components/shell.tsx` first; if `M`, STOP/BLOCKED. RE-READ the file immediately before editing and splice into current content. Surgical `git add` of only the files each task changes. Web gate: `cd apps/web && npx tsc --noEmit`. Do NOT run `next build`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/app/(app)/get-started/page.tsx` | Quick-start surface (links + checklist) |
| `apps/web/app/(app)/archived/page.tsx` | Closed/archived tickets view |
| `apps/web/components/shell.tsx` (modify) | `NavItem.section` + grouped render + 2 new entries |

---

## Task 1: Get started page

**Files:** Create `apps/web/app/(app)/get-started/page.tsx`

- [ ] **Step 1: Sanity-check primitives**

Run `grep -n "export function Card\|export function CardBody" apps/web/components/ui/primitives.tsx`. Confirm `Card`/`CardBody` exist (they do).

- [ ] **Step 2: Create the page**

```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody } from '@/components/ui/primitives';

const LINKS: { href: string; title: string; body: string }[] = [
  { href: '/tickets/new', title: 'Create a ticket', body: 'Log an incident or service request.' },
  { href: '/catalog', title: 'Browse the service catalog', body: 'Request a service from the catalog.' },
  { href: '/queues', title: 'Work your queues', body: 'See tickets assigned to your team.' },
  { href: '/kb', title: 'Knowledge base', body: 'Find and write help articles.' },
  { href: '/oncall', title: 'On-call & alerts', body: 'Check rotations and respond to alerts.' },
  { href: '/dashboards', title: 'Dashboards', body: 'Build a named operations dashboard.' },
];

export default function GetStartedPage() {
  const { me } = useAuth();
  const first = me?.email?.split('@')[0] ?? 'there';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get started</h1>
        <p className="mt-1 text-sm text-muted">Welcome, {first}. Jump into the most common tasks.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            <Card className="h-full transition-transform hover:-translate-y-0.5">
              <CardBody>
                <h3 className="text-sm font-semibold text-fg">{l.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{l.body}</p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean). Adapt if `Me` lacks `email` (run `grep -n "interface Me" -A 8 apps/web/lib/api.ts` — it has `email`).

- [ ] **Step 4: Commit**
```bash
git add "apps/web/app/(app)/get-started/page.tsx"
git commit -m "feat(get-started): in-app quick-start surface"
```

---

## Task 2: Archived work items page

**Files:** Create `apps/web/app/(app)/archived/page.tsx`

- [ ] **Step 1: Confirm Ticket fields + that GET /tickets supports status**

`grep -n "interface Ticket" -A 12 apps/web/lib/api.ts` (fields `id`, `ticket_number`, `subject`, `status`, `priority`). The `GET /tickets` route accepts `status` (confirmed). Closed tickets use status `closed`.

- [ ] **Step 2: Create the page**

```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

export default function ArchivedPage() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?status=closed&limit=200').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Archived work items</h1>
        <p className="mt-1 text-sm text-muted">
          Closed tickets. Archived knowledge-base pages are managed from the <Link className="text-brand hover:underline" href="/kb">knowledge base</Link>.
        </p>
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Ticket>
            rows={rows}
            columns={[
              { key: 'ticket_number', header: 'Ticket', render: (t) => <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> },
              { key: 'subject', header: 'Subject', render: (t) => t.subject },
              { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
              { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]}
            empty={<EmptyState title="No archived items" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
```
Confirm `PriorityBadge`/`StatusBadge` prop names against `apps/web/components/ui/badges.tsx` (used identically on `/incidents` and `/tickets`); adapt if different.

- [ ] **Step 3: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean).

- [ ] **Step 4: Commit**
```bash
git add "apps/web/app/(app)/archived/page.tsx"
git commit -m "feat(archived): closed/archived work items view"
```

---

## Task 3: Sidebar section restructure

**Files:** Modify `apps/web/components/shell.tsx`

- [ ] **Step 1: Re-read shell.tsx** (`git status` guard). Note: `NavItem = { href; label; icon; anyPerm? }`; `NEXUS_NAV` (~20 entries); `CUSTOMER_NAV`; the render maps a filtered flat `items` array inside `<nav className="flex-1 space-y-1">`; `titleFor()`.

- [ ] **Step 2: Add `section` to the `NavItem` type**

```ts
type NavItem = { href: string; label: string; icon: React.ReactNode; anyPerm?: string[]; section?: string };
```

- [ ] **Step 3: Add the two new entries + icons + assign `section` to every NEXUS_NAV entry**

Add two inline icons near the other `Icon*` (skip if a same name already exists):
```tsx
function IconRocket() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11a4 4 0 0 1 4-4M14.5 4.5C17 3 21 3 21 3s0 4-1.5 6.5C18 12 13 16 11 16l-3-3c0-2 4-7 6.5-8.5z"/><circle cx="14.5" cy="9.5" r="1"/></svg>; }
function IconArchive() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6"/></svg>; }
```

Replace the `NEXUS_NAV` array with this **section-tagged** version (preserve every existing `href`/`anyPerm`; only add `section` and the two new entries — re-check current entries when you edit and keep any the concurrent process added, tagging them into a sensible section):
```tsx
const NEXUS_NAV: NavItem[] = [
  { href: '/get-started', label: 'Get started', icon: <IconRocket /> },
  // Work
  { href: '/dashboard', label: 'Dashboard', icon: <IconGrid />, section: 'Work' },
  { href: '/tickets', label: 'Tickets', icon: <IconTicket />, section: 'Work' },
  { href: '/queues', label: 'Queues', icon: <IconLayers />, anyPerm: ['ticket.read.all_assigned_customers'], section: 'Work' },
  { href: '/incidents', label: 'Incidents', icon: <IconAlert />, section: 'Work' },
  { href: '/catalog', label: 'Service catalog', icon: <IconCatalog />, section: 'Work' },
  { href: '/kb', label: 'Knowledge base', icon: <IconBook />, anyPerm: ['kb.read'], section: 'Work' },
  { href: '/changes', label: 'Changes', icon: <IconCalendar />, anyPerm: ['change.create', 'change.approve'], section: 'Work' },
  { href: '/problems', label: 'Problems', icon: <IconBug />, anyPerm: ['problem.manage'], section: 'Work' },
  { href: '/archived', label: 'Archived', icon: <IconArchive />, section: 'Work' },
  // Operations
  { href: '/oncall', label: 'On-call', icon: <IconPager />, anyPerm: ['oncall.acknowledge', 'oncall.manage', 'oncall.page'], section: 'Operations' },
  { href: '/alerts', label: 'Alerts', icon: <IconBell />, anyPerm: ['alert.read'], section: 'Operations' },
  { href: '/services', label: 'Services', icon: <IconServer />, anyPerm: ['service.read', 'service.manage'], section: 'Operations' },
  { href: '/customers', label: 'Customers', icon: <IconUsers />, anyPerm: ['org.read', 'org.manage'], section: 'Operations' },
  { href: '/channels', label: 'Channels', icon: <IconPlug />, anyPerm: ['channel.read', 'channel.manage'], section: 'Operations' },
  { href: '/automations', label: 'Automations', icon: <IconRobot />, anyPerm: ['automation.author'], section: 'Operations' },
  // Insights
  { href: '/dashboards', label: 'Dashboards', icon: <IconGauge />, anyPerm: ['dashboard.read'], section: 'Insights' },
  { href: '/analytics', label: 'Analytics', icon: <IconChart />, anyPerm: ['report.read.operational', 'report.read.customer'], section: 'Insights' },
  { href: '/audit', label: 'Audit log', icon: <IconScroll />, anyPerm: ['audit.read'], section: 'Insights' },
  { href: '/email-logs', label: 'Email logs', icon: <IconMail />, anyPerm: ['notifications.read'], section: 'Insights' },
  // Security
  { href: '/posture', label: 'Posture', icon: <IconShield />, anyPerm: ['posture.read'], section: 'Security' },
  { href: '/compliance', label: 'Compliance', icon: <IconClipboard />, anyPerm: ['compliance.read'], section: 'Security' },
];
```
IMPORTANT: do NOT drop any entry that currently exists. If the concurrent process added a NEXUS_NAV entry not listed above, keep it and tag it with the best-fit `section`. CUSTOMER_NAV is unchanged (no `section` — it will render ungrouped exactly as today).

- [ ] **Step 4: Grouped render**

Replace the render that does `items.map((n) => { ... <Link> ... })` inside `<nav className="flex-1 space-y-1">`. First extract a `renderItem` helper (keep the EXACT existing Link markup/classes), then render ungrouped items (no `section`) followed by each section with a header:

```tsx
const SECTION_ORDER = ['Work', 'Operations', 'Insights', 'Security'];
const renderItem = (n: NavItem) => {
  const active = pathname === n.href || pathname.startsWith(n.href + '/');
  return (
    <Link
      key={n.href}
      href={n.href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        active ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <span className={cn(active ? 'text-brand' : 'text-muted')}>{n.icon}</span>
      {n.label}
    </Link>
  );
};
const ungrouped = items.filter((n) => !n.section);
```
```tsx
<nav className="flex-1 space-y-1">
  {ungrouped.map(renderItem)}
  {SECTION_ORDER.map((sec) => {
    const secItems = items.filter((n) => n.section === sec);
    if (secItems.length === 0) return null;
    return (
      <div key={sec} className="pt-3">
        <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-widest text-muted/70">{sec}</div>
        {secItems.map(renderItem)}
      </div>
    );
  })}
</nav>
```
Keep the existing `active`-state logic identical (it now lives in `renderItem`). Customer nav items have no `section`, so they all fall into `ungrouped` and render exactly as before.

- [ ] **Step 5: titleFor cases** — add (only if missing), placing `/get-started` and `/archived`:
```ts
if (path.startsWith('/get-started')) return 'Get started';
if (path.startsWith('/archived')) return 'Archived work items';
```

- [ ] **Step 6: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean).

- [ ] **Step 7: Manual smoke (controller/human, dev server running)** — agent sidebar shows section headers (Work/Operations/Insights/Security) with Get started ungrouped at top; `/get-started` and `/archived` render; customer login still shows the flat customer nav unchanged.

- [ ] **Step 8: Commit**
```bash
git add apps/web/components/shell.tsx
git commit -m "feat(nav): group agent sidebar into Work/Operations/Insights/Security sections; add Get started + Archived"
```

---

## Self-Review

**1. Spec coverage (Phase 3):**
- Get started surface → Task 1 ✓
- Archived work items (closed tickets + pointer to archived KB) → Task 2 ✓
- Nav restructure into Jira-style sections → Task 3 ✓ (Work/Operations/Insights/Security; Get started ungrouped at top)
- Filters fold-in already handled by Queues in Phase 1; no separate item.

**2. Placeholder scan:** No TBD/TODO. All page + nav code is complete. The "keep concurrent-added entries" instruction is a real splice directive (the implementer re-reads current NEXUS_NAV), not a placeholder.

**3. Type consistency:** `NavItem.section?: string` is optional, so `CUSTOMER_NAV` entries (no section) remain valid and render via `ungrouped`. `renderItem` uses the same `active`/`cn` logic and Link markup as the original. `SECTION_ORDER` strings exactly match the `section` values assigned. Both new pages reuse the verified `Ticket`/`api`/`DataTable`/badge conventions from Phase 1 pages (`/incidents`). No API/DB types involved.
