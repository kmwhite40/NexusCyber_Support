'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { api, setToken, homePath, type Me } from '@/lib/api';
import { useAuth } from './auth-context';

type View = 'admin' | 'customer';
interface DemoStatus {
  isDemo: boolean;
  currentView: View | null;
  otherView: View | null;
}

/**
 * Floating control shown only for the demo account. Toggling swaps the session to the
 * paired demo identity, flipping between the admin (control-plane) and customer (portal)
 * views, then lands on that view's home.
 */
export function DemoToggle() {
  const { me, refresh } = useAuth();
  const router = useRouter();
  const [status, setStatus] = React.useState<DemoStatus | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!me) {
      setStatus(null);
      return;
    }
    api.get<DemoStatus>('/auth/demo/status').then(setStatus).catch(() => setStatus(null));
  }, [me]);

  if (!status?.isDemo || !status.otherView) return null;

  async function toggle() {
    setBusy(true);
    try {
      const res = await api.post<{ token: string; principal: Me; view: View }>('/auth/demo/toggle');
      setToken(res.token);
      await refresh();
      router.push(homePath(res.principal.plane));
    } finally {
      setBusy(false);
    }
  }

  const current = status.currentView === 'admin' ? 'Admin' : 'Customer';
  const other = status.otherView === 'admin' ? 'Admin' : 'Customer';

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={`Demo mode — switch to ${other} view`}
        className="group flex items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-fg shadow-lg backdrop-blur transition-colors hover:border-brand/60 hover:bg-surface-2 disabled:opacity-60"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">D</span>
        <span className="text-muted">Demo · viewing as</span>
        <span className="text-fg">{current}</span>
        <ArrowRight aria-hidden className="h-4 w-4 text-muted" strokeWidth={1.75} />
        <span className="rounded-full bg-brand/15 px-2 py-0.5 text-brand">{busy ? '…' : other}</span>
      </button>
    </div>
  );
}
