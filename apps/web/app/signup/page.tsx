'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { auth, setToken, homePath, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Button, Input, Field, Select, Badge } from '@/components/ui/primitives';
import { BrandMark } from '@/components/ui/brand';
import { AuthLayout } from '@/components/ui/auth-page';

export default function SignupPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [form, setForm] = React.useState({ organizationName: '', displayName: '', email: '', password: '', cloud: 'commercial' });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, principal } = await auth.register(form);
      setToken(token);
      await refresh();
      router.push(homePath(principal.plane));
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not create account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout quote="Create an isolated organization in seconds — you control your users, data, and posture." quoteBy="Anchor Onboarding">
      <div className="flex items-center gap-2.5 lg:hidden">
        <BrandMark size={30} />
        <span className="text-xl font-semibold">Anchor</span>
      </div>

      <div className="flex flex-col space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Create your organization</h1>
        <p className="text-sm text-muted">
          You’ll become the <span className="text-fg">Org Admin</span>. Your organization is isolated from every other tenant by default.
        </p>
      </div>

      <form onSubmit={submit}>
        <Field label="Organization name">
          <Input value={form.organizationName} onChange={(e) => set('organizationName', e.target.value)} placeholder="Acme Corporation" required />
        </Field>
        <Field label="Your name">
          <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Dana Admin" />
        </Field>
        <Field label="Work email">
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@acme.com" required />
        </Field>
        <Field label="Password" hint="Minimum 10 characters. MFA is enforced in production.">
          <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="••••••••••" required />
        </Field>
        <Field label="Cloud environment">
          <Select value={form.cloud} onChange={(e) => set('cloud', e.target.value)}>
            <option value="commercial">Commercial</option>
            <option value="gcc">GCC</option>
            <option value="gcchigh">GCC High</option>
            <option value="azgov">Azure Government</option>
          </Select>
        </Field>

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <Button className="w-full" disabled={busy} type="submit">{busy ? 'Creating…' : 'Create account'}</Button>
      </form>

      <p className="text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">Sign in</Link>
      </p>

      <p className="flex items-center justify-center gap-2 text-center text-[11px] text-muted">
        Government clouds gate Teams/AI features behind validation <Badge tone="accent">cloud-aware by design</Badge>
      </p>
    </AuthLayout>
  );
}
