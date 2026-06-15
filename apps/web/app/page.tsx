'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { homePath } from '@/lib/api';
import { GLSLHills } from '@/components/ui/glsl-hills';
import { Navbar1 } from '@/components/ui/navbar1';
import { Button } from '@/components/ui/primitives';

const PILLARS = [
  { title: 'ITSM & ITIL', body: 'Incidents, requests, change & problem — one queue.' },
  { title: 'On-call & incident', body: 'Rotations, paging, escalation — one severity model.' },
  { title: 'Security posture', body: 'Findings to evidence — a system of record.' },
];

const FOOTER_LINKS = [
  { name: 'GitHub', href: 'https://github.com/kmwhite40/NexusCyber_Support' },
  { name: 'Status', href: '#' },
  { name: 'Privacy', href: '#' },
];

const navData = {
  logo: { url: '/', src: '/anchor-mark.svg', alt: 'Anchor', title: 'Anchor' },
  auth: { login: { text: 'Log in', url: '/login' }, signup: { text: 'Get started', url: '/signup' } },
};

export default function Landing() {
  const { me, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && me) router.replace(homePath(me.plane));
  }, [me, loading, router]);

  return (
    <div className="relative w-full">
      {/* ---------- Hero (clouds kept) ---------- */}
      <section className="relative flex min-h-screen w-full flex-col overflow-hidden">
        <div className="absolute inset-0">
          <GLSLHills />
        </div>
        <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-b from-bg/20 via-bg/55 to-bg" />

        <div className="relative z-20">
          <Navbar1 {...navData} />
        </div>

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="max-w-2xl space-y-6">
            <h1 className="font-semibold tracking-tight">
              <span className="block text-5xl text-fg sm:text-6xl">The cyber operations</span>
              <span className="block text-5xl font-light text-fg/55 sm:text-6xl">control plane</span>
            </h1>
            <p className="mx-auto max-w-xl text-sm leading-relaxed text-fg/60">
              ITSM, on-call response, and continuous security posture — isolated per
              customer, ready for Commercial and Government clouds.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Link href="/signup">
                <Button size="lg">
                  Get started
                  <ArrowRight className="size-4" />
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="outline" size="lg">
                  Sign in
                </Button>
              </Link>
            </div>
          </div>
        </div>

        <div className="relative z-10 mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 text-[11px] uppercase tracking-widest text-fg/40">
          <span>NIST 800-53</span><span aria-hidden>·</span>
          <span>CMMC 2.0</span><span aria-hidden>·</span>
          <span>FedRAMP</span><span aria-hidden>·</span>
          <span>SOC 2</span><span aria-hidden>·</span>
          <span>ISO 27001</span>
        </div>
      </section>

      {/* ---------- Pillar strip (no cards, no animation) ---------- */}
      <section className="relative z-10 border-t border-border bg-surface">
        <div className="mx-auto grid max-w-5xl grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          {PILLARS.map((p) => (
            <div key={p.title} className="px-8 py-10">
              <h2 className="text-sm font-semibold text-fg">{p.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-fg/55">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- Minimal footer (one line) ---------- */}
      <footer className="relative z-10 border-t border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-fg/45 sm:flex-row">
          <span>Copyright © 2026 NexusCyber. Operated as part of Strategic Business Systems, Inc. All rights reserved.</span>
          <nav className="flex items-center gap-5">
            {FOOTER_LINKS.map((l) => (
              <Link key={l.name} href={l.href} className="transition-colors hover:text-fg/80">
                {l.name}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
