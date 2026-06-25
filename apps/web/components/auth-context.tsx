'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { auth, setToken, type Me } from '@/lib/api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
}

const Ctx = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  const refresh = React.useCallback(async () => {
    try {
      const m = await auth.me();
      setMe(m);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = React.useCallback(() => {
    setToken(null);
    setMe(null);
    // Reset the welcome dialog so it shows again on the next login.
    try { sessionStorage.removeItem('anchor-welcome-seen'); } catch { /* ignore */ }
    router.push('/login');
  }, [router]);

  const can = React.useCallback(
    (perm: string) => !!me && (me.capabilities.includes(perm) || me.capabilities.includes('admin.superuser')),
    [me],
  );

  return <Ctx.Provider value={{ me, loading, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
