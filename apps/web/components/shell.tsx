'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useAuth } from './auth-context';
import { Badge } from './ui/primitives';
import { Avatar, AvatarFallback } from './ui/avatar';
import { BrandMark } from './ui/brand';

type NavItem = { href: string; label: string; icon: React.ReactNode; anyPerm?: string[] };

// Agents get the operational control plane; customers get a focused support experience.
const NEXUS_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: <IconGrid /> },
  { href: '/catalog', label: 'Service catalog', icon: <IconCatalog /> },
  { href: '/kb', label: 'Knowledge base', icon: <IconBook />, anyPerm: ['kb.read'] },
  { href: '/tickets', label: 'Tickets', icon: <IconTicket /> },
  { href: '/queues', label: 'Queues', icon: <IconLayers />, anyPerm: ['ticket.read.all_assigned_customers'] },
  { href: '/changes', label: 'Changes', icon: <IconCalendar />, anyPerm: ['change.create', 'change.approve'] },
  { href: '/problems', label: 'Problems', icon: <IconBug />, anyPerm: ['problem.manage'] },
  { href: '/analytics', label: 'Analytics', icon: <IconChart />, anyPerm: ['report.read.operational', 'report.read.customer'] },
  { href: '/oncall', label: 'On-call', icon: <IconPager />, anyPerm: ['oncall.acknowledge', 'oncall.manage', 'oncall.page'] },
  { href: '/posture', label: 'Posture', icon: <IconShield />, anyPerm: ['posture.read'] },
  { href: '/compliance', label: 'Compliance', icon: <IconClipboard />, anyPerm: ['compliance.read'] },
  { href: '/automations', label: 'Automations', icon: <IconRobot />, anyPerm: ['automation.author'] },
  { href: '/audit', label: 'Audit log', icon: <IconScroll />, anyPerm: ['audit.read'] },
];

const CUSTOMER_NAV: NavItem[] = [
  { href: '/portal', label: 'Get help', icon: <IconHelp /> },
  { href: '/kb', label: 'Knowledge base', icon: <IconBook />, anyPerm: ['kb.read'] },
  { href: '/tickets', label: 'My requests', icon: <IconTicket /> },
  { href: '/catalog', label: 'Service catalog', icon: <IconCatalog /> },
  { href: '/posture', label: 'Security posture', icon: <IconShield />, anyPerm: ['posture.read'] },
  { href: '/compliance', label: 'Compliance', icon: <IconClipboard />, anyPerm: ['compliance.read'] },
  { href: '/analytics', label: 'Reports', icon: <IconChart />, anyPerm: ['report.read.customer'] },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, loading, logout, can } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [loading, me, router]);

  if (loading || !me) {
    return <div className="grid min-h-screen place-items-center text-muted">Loading…</div>;
  }

  const isCustomer = me.plane === 'customer';
  const items = (isCustomer ? CUSTOMER_NAV : NEXUS_NAV).filter((n) => !n.anyPerm || n.anyPerm.some((p) => can(p)));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border glass px-3 py-5 md:flex">
        <Link href={isCustomer ? '/portal' : '/dashboard'} className="mb-7 flex items-center gap-2.5 px-2">
          <BrandMark size={34} />
          <div>
            <div className="text-sm font-semibold leading-none text-fg">Anchor</div>
            <div className="text-[10px] uppercase tracking-widest text-muted">{isCustomer ? 'Support' : 'Control Plane'}</div>
          </div>
        </Link>

        <nav className="flex-1 space-y-1">
          {items.map((n) => {
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
          })}
        </nav>

        <div className="rounded-lg border border-border bg-surface-2/60 p-3">
          <div className="flex items-center gap-2.5">
            <Avatar className="h-9 w-9">
              <AvatarFallback className="bg-gradient-to-br from-brand to-accent text-xs font-bold text-brand-fg">
                {me.email.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-fg">{me.email}</div>
              <div className="text-[10px] text-muted">{me.plane === 'nexus' ? 'Anchor agent' : 'Customer'}</div>
            </div>
          </div>
          <button type="button" onClick={logout} className="mt-3 w-full rounded-md border border-border py-1.5 text-xs text-muted hover:bg-border hover:text-fg">
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border glass px-5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-fg">{titleFor(pathname)}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone="brand">{me.roles[0] ?? 'user'}</Badge>
            <Badge tone="neutral">{me.plane}</Badge>
          </div>
        </header>
        <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function titleFor(path: string): string {
  if (path.startsWith('/portal')) return 'Help center';
  if (path.startsWith('/tickets/new')) return 'Submit a ticket';
  if (path.startsWith('/tickets/')) return 'Ticket';
  if (path.startsWith('/tickets')) return 'Tickets';
  if (path.startsWith('/catalog')) return 'Service catalog';
  if (path.startsWith('/kb')) return 'Knowledge base';
  if (path.startsWith('/changes')) return 'Change management';
  if (path.startsWith('/problems')) return 'Problem management';
  if (path.startsWith('/queues')) return 'Work queues';
  if (path.startsWith('/oncall')) return 'On-call console';
  if (path.startsWith('/posture')) return 'Security posture';
  if (path.startsWith('/compliance')) return 'Compliance';
  if (path.startsWith('/automations')) return 'Automation rules';
  if (path.startsWith('/analytics')) return 'Helpdesk analytics';
  if (path.startsWith('/audit')) return 'Audit log';
  return 'Dashboard';
}

// --- inline icons (no icon-lib dependency; gov-egress-safe) ---
function IconGrid() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>; }
function IconTicket() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4V8z"/></svg>; }
function IconShield() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>; }
function IconScroll() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8M8 3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2M8 3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2M12 8h4M12 12h4"/></svg>; }
function IconChart() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="12" y="7" width="3" height="10" rx="1"/><rect x="17" y="13" width="3" height="4" rx="1"/></svg>; }
function IconCatalog() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></svg>; }
function IconPager() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>; }
function IconHelp() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3 2.5c-.7.3-1 .8-1 1.5v.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>; }
function IconClipboard() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v1H9V4z"/><path d="M9 11l2 2 4-4"/></svg>; }
function IconBook() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5z"/><path d="M18 17H6a2 2 0 0 0-2 2"/></svg>; }
function IconCalendar() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>; }
function IconBug() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="8" y="6" width="8" height="12" rx="4"/><path d="M12 6V4M5 9l2 1M19 9l-2 1M5 15l2-1M19 15l-2-1M4 12h2M18 12h2"/></svg>; }
function IconLayers() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5"/></svg>; }
function IconRobot() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4M9 13h.01M15 13h.01M9 16h6"/><circle cx="12" cy="3" r="1"/></svg>; }
