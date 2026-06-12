'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { auth, setToken, homePath } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { BrandMark } from '@/components/ui/brand';

// Landing page for the Entra OIDC redirect. The API callback appends the session
// token (or an error) to the URL fragment so it never hits a server log; here we
// pull it out, store it, hydrate the auth context, and route to the home plane.
export default function OidcCallbackPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
    const params = new URLSearchParams(hash);
    const err = params.get('error');
    const token = params.get('token');
    if (err) {
      setError(err);
      return;
    }
    if (!token) {
      setError('No session token returned.');
      return;
    }
    (async () => {
      try {
        setToken(token);
        // Clear the token from the URL so it isn't bookmarked or shared.
        window.history.replaceState(null, '', '/auth/callback');
        const me = await auth.me();
        await refresh();
        router.replace(homePath(me.plane));
      } catch {
        setToken(null);
        setError('Could not establish a session. Please try signing in again.');
      }
    })();
  }, [router, refresh]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg text-fg">
      <BrandMark size={40} />
      {error ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="rounded-md border border-border px-4 py-2 text-sm hover:border-brand/40"
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted">Completing sign-in…</p>
      )}
    </div>
  );
}
