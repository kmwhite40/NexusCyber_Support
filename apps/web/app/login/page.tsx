'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { auth, setToken, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Card, Input, Field, Badge } from '@/components/ui/primitives';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [demos, setDemos] = React.useState<Array<{ email: string; display_name: string; plane: string; org: string | null; roles: string[] }>>([]);

  React.useEffect(() => {
    auth.devUsers().then((r) => setDemos(r.users)).catch(() => {});
  }, []);

  async function finish(p: Promise<{ token: string }>) {
    setBusy(true);
    setError(null);
    try {
      const { token } = await p;
      setToken(token);
      await refresh();
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border p-12 lg:flex">
        <div className="pointer-events-none absolute -left-20 top-1/3 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-10 bottom-0 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
        <div className="flex items-center gap-2.5">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-brand-fg shadow-glow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z"/></svg>
          </div>
          <span className="text-lg font-semibold">Nexus</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            One control plane for ITSM, on-call, and security posture.
          </h1>
          <p className="mt-4 text-sm text-muted">
            Multi-tenant. Government-cloud aware. Built for MSPs operating across Commercial,
            GCC, GCC High and Azure Government — with tenant isolation, RBAC + ABAC, and
            compliance evidence by default.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge tone="brand">Tenant isolation (RLS)</Badge>
            <Badge tone="accent">GCC High ready</Badge>
            <Badge tone="success">Posture system-of-record</Badge>
          </div>
        </div>
        <p className="text-xs text-muted">© Nexus — reference implementation</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Welcome back</h2>
          <p className="mt-1 text-sm text-muted">Sign in to your Nexus workspace.</p>

          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              finish(auth.login(email, password).then((r) => r));
            }}
          >
            <Field label="Email">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            {error && <p className="mb-3 text-xs text-danger">{error}</p>}
            <Button className="w-full" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted">
            No account?{' '}
            <Link href="/signup" className="font-medium text-brand hover:underline">Create one</Link>
          </p>

          {demos.length > 0 && (
            <Card className="mt-7 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-fg">Demo identities</span>
                <Badge tone="warning">dev only</Badge>
              </div>
              <p className="mb-3 text-[11px] text-muted">One-click sign-in to explore tenant isolation & RBAC.</p>
              <div className="space-y-1.5">
                {demos.map((u) => (
                  <button
                    key={u.email}
                    onClick={() => finish(auth.devLogin(u.email).then((r) => r))}
                    disabled={busy}
                    className="flex w-full items-center justify-between rounded-md border border-border bg-surface-2/50 px-3 py-2 text-left transition hover:border-brand/40 hover:bg-surface-2"
                  >
                    <div>
                      <div className="text-xs font-medium text-fg">{u.display_name}</div>
                      <div className="text-[10px] text-muted">{u.email}</div>
                    </div>
                    <Badge tone={u.plane === 'nexus' ? 'brand' : 'neutral'}>{u.org ?? 'Nexus'}</Badge>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
