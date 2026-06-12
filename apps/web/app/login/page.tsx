'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AtSign } from 'lucide-react';
import { auth, setToken, homePath, ApiError, oidcStartUrl, oidcCustomerStartUrl } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Card, Input, Badge } from '@/components/ui/primitives';
import { BrandMark } from '@/components/ui/brand';
import { AuthLayout, AuthSeparator } from '@/components/ui/auth-page';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [demos, setDemos] = React.useState<Array<{ email: string; display_name: string; plane: string; org: string | null; roles: string[] }>>([]);
  const [sso, setSso] = React.useState<{ enabled: boolean; label: string; customerEnabled: boolean; customerLabel: string }>({
    enabled: false,
    label: '',
    customerEnabled: false,
    customerLabel: '',
  });

  React.useEffect(() => {
    auth.devUsers().then((r) => setDemos(r.users)).catch(() => {});
    auth
      .config()
      .then((c) =>
        setSso({
          enabled: c.oidcEnabled,
          label: c.oidcLabel,
          customerEnabled: c.customerOidcEnabled,
          customerLabel: c.customerOidcLabel,
        }),
      )
      .catch(() => {});
  }, []);

  async function finish(p: Promise<{ token: string; principal: { plane: 'nexus' | 'customer' } }>) {
    setBusy(true);
    setError(null);
    try {
      const { token, principal } = await p;
      setToken(token);
      await refresh();
      router.push(homePath(principal.plane));
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout quote="This platform helps us serve our customers faster — across commercial and government clouds." quoteBy="Anchor Service Desk">
      {/* mobile brand */}
      <div className="flex items-center gap-2.5 lg:hidden">
        <BrandMark size={30} />
        <span className="text-xl font-semibold">Anchor</span>
      </div>

      <div className="flex flex-col space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted">Sign in to your Anchor workspace.</p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          finish(auth.login(email, password));
        }}
      >
        <div className="relative">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="ps-9" required />
          <AtSign className="pointer-events-none absolute inset-y-0 start-0 my-auto ms-3 size-4 text-muted" aria-hidden />
        </div>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button className="w-full" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>

      {(sso.enabled || sso.customerEnabled) && (
        <>
          <AuthSeparator label="OR" />
          {sso.enabled && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => {
                window.location.href = oidcStartUrl;
              }}
            >
              {sso.label || 'Sign in with Microsoft (Gov)'}
            </Button>
          )}
          {sso.customerEnabled && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => {
                window.location.href = oidcCustomerStartUrl;
              }}
            >
              {sso.customerLabel || 'Sign in with your organization'}
            </Button>
          )}
        </>
      )}

      <p className="text-center text-sm text-muted">
        No account?{' '}
        <Link href="/signup" className="font-medium text-brand hover:underline">Create one</Link>
      </p>

      {demos.length > 0 && (
        <>
          <AuthSeparator label="OR EXPLORE THE DEMO" />
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-fg">Demo identities</span>
              <Badge tone="warning">dev only</Badge>
            </div>
            <div className="space-y-1.5">
              {demos.map((u) => (
                <button
                  key={u.email}
                  type="button"
                  onClick={() => finish(auth.devLogin(u.email))}
                  disabled={busy}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-surface-2/50 px-3 py-2 text-left transition hover:border-brand/40 hover:bg-surface-2"
                >
                  <div>
                    <div className="text-xs font-medium text-fg">{u.display_name}</div>
                    <div className="text-[10px] text-muted">{u.email}</div>
                  </div>
                  <Badge tone={u.plane === 'nexus' ? 'brand' : 'neutral'}>{u.org ?? 'Anchor'}</Badge>
                </button>
              ))}
            </div>
          </Card>
        </>
      )}

      <p className="text-xs text-muted">
        By continuing, you agree to our{' '}
        <Link href="#" className="underline underline-offset-4 hover:text-fg">Terms of Service</Link> and{' '}
        <Link href="#" className="underline underline-offset-4 hover:text-fg">Privacy Policy</Link>.
      </p>
    </AuthLayout>
  );
}
