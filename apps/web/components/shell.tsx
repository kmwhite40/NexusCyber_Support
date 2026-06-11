'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useAuth } from './auth-context';
import { Badge } from './ui/primitives';
import { Avatar, AvatarFallback } from './ui/avatar';

const NAV: Array<{ href: string; label: string; icon: React.ReactNode; anyPerm?: string[] }> = [
  { href: '/dashboard', label: 'Dashboard', icon: <IconGrid /> },
  { href: '/catalog', label: 'Service catalog', icon: <IconCatalog /> },
  { href: '/tickets', label: 'Tickets', icon: <IconTicket /> },
  { href: '/analytics', label: 'Analytics', icon: <IconChart />, anyPerm: ['report.read.operational', 'report.read.customer'] },
  { href: '/posture', label: 'Posture', icon: <IconShield />, anyPerm: ['posture.read'] },
  { href: '/audit', label: 'Audit log', icon: <IconScroll />, anyPerm: ['audit.read'] },
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

  const items = NAV.filter((n) => !n.anyPerm || n.anyPerm.some((p) => can(p)));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border glass px-3 py-5 md:flex">
        <Link href="/dashboard" className="mb-7 flex items-center gap-2.5 px-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-brand-fg shadow-glow">
            <IconBolt />
          </div>
          <div>
            <div className="text-sm font-semibold leading-none text-fg">Nexus Cyber</div>
            <div className="text-[10px] uppercase tracking-widest text-muted">Control Plane</div>
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
              <div className="text-[10px] text-muted">{me.plane === 'nexus' ? 'Nexus agent' : 'Customer'}</div>
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
  if (path.startsWith('/tickets/new')) return 'Submit a ticket';
  if (path.startsWith('/tickets/')) return 'Ticket';
  if (path.startsWith('/tickets')) return 'Tickets';
  if (path.startsWith('/catalog')) return 'Service catalog';
  if (path.startsWith('/posture')) return 'Security posture';
  if (path.startsWith('/analytics')) return 'Helpdesk analytics';
  if (path.startsWith('/audit')) return 'Audit log';
  return 'Dashboard';
}

// --- inline icons (no icon-lib dependency; gov-egress-safe) ---
function IconGrid() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>; }
function IconTicket() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4V8z"/></svg>; }
function IconShield() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>; }
function IconScroll() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8M8 3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2M8 3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2M12 8h4M12 12h4"/></svg>; }
function IconBolt() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z"/></svg>; }
function IconChart() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="12" y="7" width="3" height="10" rx="1"/><rect x="17" y="13" width="3" height="4" rx="1"/></svg>; }
function IconCatalog() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></svg>; }
