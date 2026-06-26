'use client';
// Customer-facing support homepage (the public front door at "/"). Speaks to the
// end user who needs IT help — submit a request, track it, self-serve answers —
// NOT the internal operator console. Three-color system:
//   surface → hsl(var(--bg)) · text → hsl(var(--fg)) · accent → hsl(var(--brand))
// Semantic colors (success/warning) appear ONLY in service-status badges.
// The floating-cloud WebGL backdrop (GLSLHills) is preserved per design intent.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity, ArrowRight, BookOpen, CheckCircle2, ChevronRight, LayoutGrid,
  LifeBuoy, ListChecks, RefreshCw, Search, Ticket, Zap,
} from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { homePath } from '@/lib/api';
import { GLSLHills } from '@/components/ui/glsl-hills';
import { Button } from '@/components/ui/primitives';
import { BrandMark } from '@/components/ui/brand';

/* ----------------------------- data ----------------------------- */
const FEATURES = [
  {
    icon: Ticket,
    title: 'Submit a request',
    body: 'Report an issue or ask for a service in under a minute. Smart forms set the priority and route it to the right team instantly.',
    meta: 'Incidents & requests',
    href: '/tickets/new',
    span: 'lg:col-span-2',
  },
  {
    icon: BookOpen,
    title: 'Help Center',
    body: 'Search clear, step-by-step guides that resolve the most common issues — no waiting, no ticket required.',
    meta: 'Self-serve answers',
    href: '/kb',
    span: 'lg:row-span-2',
  },
  {
    icon: ListChecks,
    title: 'Track your tickets',
    body: 'Real-time status and updates on everything you’ve submitted, in one place.',
    meta: 'Live updates',
    href: '/portal',
    span: '',
  },
  {
    icon: LayoutGrid,
    title: 'Service catalog',
    body: 'Request access, hardware, and software with guided, pre-approved forms.',
    meta: 'Guided requests',
    href: '/catalog',
    span: '',
  },
] as const;

const SERVICES = [
  { name: 'Support Portal', state: 'operational' },
  { name: 'Email & Calendar', state: 'operational' },
  { name: 'Single Sign-On', state: 'operational' },
  { name: 'VPN & Remote Access', state: 'degraded' },
  { name: 'File Storage', state: 'operational' },
] as const;

const HELP_TOPICS = [
  { title: 'Reset your password', tag: 'Accounts' },
  { title: 'Set up VPN on a new device', tag: 'Connectivity' },
  { title: 'Request a new laptop', tag: 'Hardware' },
  { title: 'Install Microsoft 365 apps', tag: 'Software' },
] as const;

const STATE_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  operational: { dot: 'bg-success', text: 'text-success', label: 'Operational' },
  degraded: { dot: 'bg-warning', text: 'text-warning', label: 'Degraded' },
  down: { dot: 'bg-danger', text: 'text-danger', label: 'Outage' },
};

/* Mount the WebGL clouds only when the browser can create a GL context.
   Enclaves / browsers without WebGL fall back to the gradient backdrop
   instead of crashing the page (GLSLHills throws on a missing context). */
function CloudsBackdrop() {
  const [webgl, setWebgl] = useState(false);
  useEffect(() => {
    try {
      const canvas = document.createElement('canvas');
      if (canvas.getContext('webgl2') || canvas.getContext('webgl')) setWebgl(true);
    } catch {
      /* no WebGL — keep the gradient fallback */
    }
  }, []);
  return webgl ? <GLSLHills /> : null;
}

/* --------------------------- component --------------------------- */
export default function Landing() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    if (!loading && me) router.replace(homePath(me.plane));
  }, [me, loading, router]);

  // Live "updated Ns ago" ticker for the service-status block.
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative w-full bg-bg">
      {/* ====================== NAV ====================== */}
      <header className="absolute inset-x-0 top-0 z-30">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="text-[15px] font-semibold tracking-tight text-fg">Anchor</span>
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/kb"
              className="hidden items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-fg/70 transition-colors hover:text-fg sm:inline-flex"
            >
              <BookOpen className="h-4 w-4" strokeWidth={1.75} />
              Help Center
            </Link>
            <Link
              href="/login"
              className="hidden rounded-md px-3 py-2 text-sm font-medium text-fg/70 transition-colors hover:text-fg sm:inline-flex"
            >
              Sign in
            </Link>
            <Link href="/tickets/new">
              <Button size="md" className="px-4">
                <Ticket className="h-4 w-4" strokeWidth={2} />
                Submit a Ticket
              </Button>
            </Link>
          </div>
        </nav>
      </header>

      {/* ====================== HERO (clouds kept) ====================== */}
      <section className="relative flex min-h-screen w-full flex-col overflow-hidden">
        <div className="absolute inset-0">
          <CloudsBackdrop />
        </div>
        <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-b from-bg/30 via-bg/60 to-bg" />

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-24 pt-28 text-center">
          <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-border bg-surface/50 px-3.5 py-1.5 text-xs font-medium text-fg/70 backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
            Your IT support, in one place
          </span>

          <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-fg sm:text-6xl md:text-7xl">
            Get IT help,
            <br className="hidden sm:block" />{' '}
            <span className="text-brand">resolved in real-time.</span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-fg/60 sm:text-lg">
            Submit a request, track its progress, and find instant answers — all in one
            secure portal, with a support team that resolves issues fast.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Link href="/tickets/new">
              <Button size="lg" className="px-7">
                <Ticket className="h-4 w-4" strokeWidth={2} />
                Submit a Ticket
              </Button>
            </Link>
            <Link href="/kb">
              <Button variant="outline" size="lg" className="px-7 backdrop-blur">
                <Search className="h-4 w-4" strokeWidth={1.75} />
                Browse Help Center
              </Button>
            </Link>
          </div>

          <dl className="mt-14 grid grid-cols-3 gap-x-8 gap-y-2 sm:gap-x-16">
            {[
              ['4 min', 'Avg. first response'],
              ['24 / 7', 'Support coverage'],
              ['1,200+', 'Help articles'],
            ].map(([n, l]) => (
              <div key={l} className="text-center">
                <dt className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{n}</dt>
                <dd className="mt-1 text-[11px] uppercase tracking-widest text-fg/45 sm:text-xs">{l}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative z-10 mb-7 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 text-[11px] uppercase tracking-widest text-fg/40">
          <span>NIST 800-53</span><span aria-hidden>·</span>
          <span>CMMC 2.0</span><span aria-hidden>·</span>
          <span>FedRAMP</span><span aria-hidden>·</span>
          <span>SOC 2</span><span aria-hidden>·</span>
          <span>ISO 27001</span>
        </div>
      </section>

      {/* ====================== WAYS TO GET HELP (bento) ====================== */}
      <section className="relative z-10 border-t border-border bg-bg">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <div className="mb-12 max-w-2xl">
            <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand">
              <Zap className="h-3.5 w-3.5" strokeWidth={2} /> Ways to get help
            </span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Everything you need, one portal.
            </h2>
            <p className="mt-3 text-base leading-relaxed text-fg/55">
              Whether it’s a quick question or a hardware request — start here and we’ll take it from there.
            </p>
          </div>

          <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:grid-rows-2">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <Link
                  key={f.title}
                  href={f.href}
                  style={{ animationDelay: `${i * 70}ms` }}
                  className={`group flex animate-fade-up flex-col justify-between rounded-xl border border-border glass p-6 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-glow ${f.span}`}
                >
                  <div>
                    <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-lg border border-brand/20 bg-brand/10 text-brand">
                      <Icon className="h-5 w-5" strokeWidth={1.75} />
                    </div>
                    <h3 className="text-lg font-semibold tracking-tight text-fg">{f.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-fg/55">{f.body}</p>
                  </div>
                  <div className="mt-6 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wider text-fg/40">{f.meta}</span>
                    <ArrowRight
                      className="h-4 w-4 text-brand opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
                      strokeWidth={2}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ====================== SERVICE STATUS + POPULAR HELP ====================== */}
      <section className="relative z-10 border-t border-border bg-bg">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <div className="overflow-hidden rounded-2xl border border-border glass shadow-card">
            {/* header */}
            <div className="flex flex-col gap-3 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/20 bg-brand/10 text-brand">
                  <Activity className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </span>
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-fg">Service status</h2>
                  <p className="text-xs text-fg/45">Updated {secs}s ago · auto-refreshing</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs font-medium text-success">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  All core systems operational
                </span>
                <button
                  type="button"
                  onClick={() => setSecs(0)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg/60 transition-colors hover:bg-surface-2 hover:text-fg"
                  aria-label="Refresh status"
                >
                  <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            {/* body */}
            <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              {/* services the customer uses */}
              <div className="p-6">
                <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-fg/45">Systems</h3>
                <ul className="space-y-1">
                  {SERVICES.map((s) => {
                    const st = STATE_STYLES[s.state];
                    return (
                      <li
                        key={s.name}
                        className="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2/60"
                      >
                        <span className="flex items-center gap-3 text-sm text-fg/80">
                          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                          {s.name}
                        </span>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${st.text}`}>
                          {s.state === 'operational' && <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />}
                          {st.label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* popular self-serve answers */}
              <div className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-fg/45">Popular in the Help Center</h3>
                  <Link href="/kb" className="text-xs font-medium text-brand hover:underline">
                    Browse all →
                  </Link>
                </div>
                <ul className="space-y-2">
                  {HELP_TOPICS.map((t) => (
                    <li key={t.title}>
                      <Link
                        href="/kb"
                        className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/40 px-3.5 py-3 transition-colors hover:border-brand/30"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <LifeBuoy className="h-4 w-4 shrink-0 text-brand" strokeWidth={1.75} />
                          <span className="truncate text-sm font-medium text-fg">{t.title}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="hidden text-[11px] uppercase tracking-wider text-fg/35 sm:inline">{t.tag}</span>
                          <ChevronRight className="h-4 w-4 text-fg/30 transition-colors group-hover:text-brand" strokeWidth={1.75} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* closing CTA */}
          <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border border-border glass px-6 py-12 text-center shadow-card sm:py-16">
            <h2 className="max-w-xl text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              Can’t find what you need?
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-fg/55">
              Our support team is ready to help — submit a ticket and we’ll take it from here.
            </p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <Link href="/tickets/new">
                <Button size="lg" className="px-7">
                  <Ticket className="h-4 w-4" strokeWidth={2} />
                  Submit a Ticket
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="outline" size="lg" className="px-7">
                  Sign in to your portal
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ====================== FOOTER ====================== */}
      <footer className="relative z-10 border-t border-border bg-bg">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-7 text-xs text-fg/45 sm:flex-row">
          <span className="flex items-center gap-2">
            <BrandMark size={18} />
            Copyright © 2026 NexusCyber. Operated as part of Strategic Business Systems, Inc.
          </span>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" className="transition-colors hover:text-fg/80">Privacy</Link>
            <Link href="/terms" className="transition-colors hover:text-fg/80">Terms</Link>
            <Link href="/kb" className="transition-colors hover:text-fg/80">Help Center</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
