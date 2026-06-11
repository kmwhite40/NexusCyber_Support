'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Ticket,
  Siren,
  ShieldCheck,
  Lock,
  Cloud,
  Workflow,
  Database,
  FileCheck,
  Network,
  Bot,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { GLSLHills } from '@/components/ui/glsl-hills';
import DisplayCards from '@/components/ui/display-cards';
import { Navbar1 } from '@/components/ui/navbar1';
import { LiquidButton, MetalButton } from '@/components/ui/liquid-glass-button';
import { Card, CardBody, Badge } from '@/components/ui/primitives';

const PILLAR_CARDS = [
  {
    icon: <Ticket className="size-4 text-brand" />,
    title: 'ITSM & ITIL',
    description: 'Incidents, requests, change & problem',
    date: 'One queue, every customer',
    iconClassName: 'text-brand',
    titleClassName: 'text-brand',
    className:
      "[grid-area:stack] hover:-translate-y-10 before:absolute before:w-[100%] before:outline-1 before:rounded-xl before:outline-border before:h-[100%] before:content-[''] before:bg-blend-overlay before:bg-background/50 grayscale-[100%] hover:before:opacity-0 before:transition-opacity before:duration-700 hover:grayscale-0 before:left-0 before:top-0",
  },
  {
    icon: <Siren className="size-4 text-accent" />,
    title: 'On-call & Major Incident',
    description: 'Rotations, paging, escalation',
    date: 'One severity model',
    iconClassName: 'text-accent',
    titleClassName: 'text-accent',
    className:
      "[grid-area:stack] translate-x-16 translate-y-10 hover:-translate-y-1 before:absolute before:w-[100%] before:outline-1 before:rounded-xl before:outline-border before:h-[100%] before:content-[''] before:bg-blend-overlay before:bg-background/50 grayscale-[100%] hover:before:opacity-0 before:transition-opacity before:duration-700 hover:grayscale-0 before:left-0 before:top-0",
  },
  {
    icon: <ShieldCheck className="size-4 text-success" />,
    title: 'Security Posture',
    description: 'Findings, evidence, remediation',
    date: 'System of record',
    iconClassName: 'text-success',
    titleClassName: 'text-success',
    className: '[grid-area:stack] translate-x-32 translate-y-20 hover:translate-y-10',
  },
];

const FEATURES = [
  { icon: Lock, title: 'Tenant isolation by default', body: 'Postgres row-level security plus an app-layer org guard — belt and suspenders, per request.' },
  { icon: Cloud, title: 'Dual sovereignty', body: 'One codebase deploys to Commercial and a separate Azure Government enclave, gated by a capability matrix.' },
  { icon: ShieldCheck, title: 'Posture as a system of record', body: 'Findings linked to tickets, SLAs, evidence and POA&M — not a bolt-on GRC tool.' },
  { icon: Workflow, title: 'Automation with guardrails', body: 'Simulate → publish → rollback, human-in-the-loop, idempotent actions, full audit.' },
  { icon: Database, title: 'CMDB & assets', body: 'Configuration items, relationships and Graph discovery driving impact analysis.' },
  { icon: FileCheck, title: 'Evidence by default', body: 'Consent records, audit logs, change records and snapshots packaged for assessors.' },
  { icon: Network, title: 'Microsoft 365 native', body: 'Graph, Teams and email per-cloud — national endpoints, least-privilege, secretless.' },
  { icon: Bot, title: 'AI — optional & isolated', body: 'Per-tenant, off by default in gov, no cross-tenant training, human-approved output.' },
];

const STATS = [
  { value: '4', label: 'Cloud environments' },
  { value: '100%', label: 'Tenant isolation' },
  { value: '11', label: 'Ticket types' },
  { value: 'A–F', label: 'Posture grading' },
];

const navData = {
  logo: { url: '/', src: '/nexus-mark.svg', alt: 'Nexus Cyber', title: 'Nexus Cyber' },
  auth: { login: { text: 'Log in', url: '/login' }, signup: { text: 'Get started', url: '/signup' } },
};

export default function Landing() {
  const { me, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && me) router.replace('/dashboard');
  }, [me, loading, router]);

  return (
    <div className="relative w-full">
      {/* ---------- Hero ---------- */}
      <section className="relative flex min-h-screen w-full flex-col overflow-hidden">
        <div className="absolute inset-0">
          <GLSLHills />
        </div>
        <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-b from-bg/20 via-bg/55 to-bg" />

        {/* Navbar (vendored 21st.dev Navbar1) */}
        <div className="relative z-20">
          <Navbar1 {...navData} />
        </div>

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="max-w-3xl space-y-6">
            <div className="flex justify-center">
              <Badge tone="accent">Multi-tenant · GCC High ready · Posture-native</Badge>
            </div>
            <h1 className="font-semibold tracking-tight">
              <span className="block text-5xl font-thin italic text-fg/80 sm:text-6xl">The cyber operations</span>
              <span className="block bg-gradient-to-r from-brand via-fg to-accent bg-clip-text text-6xl text-transparent sm:text-7xl">
                control plane
              </span>
            </h1>
            <p className="mx-auto max-w-xl text-sm text-fg/60">
              Nexus Cyber unifies IT service management, on-call response, and continuous security
              posture — isolated per customer and ready for Commercial and Government clouds.
            </p>
            <div className="flex items-center justify-center gap-4 pt-2">
              <Link href="/signup">
                <LiquidButton size="xl" className="text-fg">
                  Create your organization
                  <ArrowRight className="ml-1 size-4" />
                </LiquidButton>
              </Link>
              <Link href="/login">
                <MetalButton variant="default">Explore the demo</MetalButton>
              </Link>
            </div>
          </div>
        </div>

        <div className="relative z-10 mb-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 px-6 text-[11px] uppercase tracking-widest text-fg/40">
          <span>NIST 800-53 / 171</span><span>·</span><span>CMMC 2.0</span><span>·</span>
          <span>FedRAMP</span><span>·</span><span>SOC 2</span><span>·</span><span>ISO 27001</span>
        </div>
      </section>

      {/* ---------- Pillars (DisplayCards) ---------- */}
      <section className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-6 py-24">
        <Badge tone="brand">Three products, one platform</Badge>
        <h2 className="mt-4 text-center text-3xl font-semibold tracking-tight sm:text-4xl">
          ITSM, on-call, and posture — fused
        </h2>
        <p className="mt-3 max-w-xl text-center text-sm text-fg/60">
          No second vendor, no second source of truth. A posture finding becomes a ticket, a ticket
          can page on-call, and every action produces compliance evidence.
        </p>
        <div className="mt-16 w-full">
          <DisplayCards cards={PILLAR_CARDS} />
        </div>
      </section>

      {/* ---------- Feature grid ---------- */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10 text-center">
          <Badge tone="accent">Enterprise-grade by design</Badge>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Built for the hardest tenants</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <Card key={f.title} className="h-full transition-transform hover:-translate-y-1">
              <CardBody>
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface-2 text-brand">
                  <f.icon className="size-5" />
                </div>
                <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{f.body}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------- Stats band ---------- */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 py-16">
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 divide-x divide-border md:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="px-6 py-8 text-center">
                <div className="bg-gradient-to-b from-fg to-fg/50 bg-clip-text text-4xl font-semibold text-transparent tabular-nums">
                  {s.value}
                </div>
                <div className="mt-1 text-xs uppercase tracking-wider text-muted">{s.label}</div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* ---------- CTA ---------- */}
      <section className="relative z-10 mx-auto max-w-4xl px-6 py-24 text-center">
        <h2 className="text-4xl font-semibold tracking-tight">Stand up your control plane.</h2>
        <p className="mx-auto mt-3 max-w-lg text-sm text-fg/60">
          Create an isolated organization in seconds, or sign in to the demo to explore tenant
          isolation, RBAC + ABAC, the SLA engine, and the posture database live.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/signup">
            <LiquidButton size="xl" className="text-fg">
              Get started free
              <ArrowRight className="ml-1 size-4" />
            </LiquidButton>
          </Link>
          <Link href="/login" className="text-sm font-medium text-brand hover:underline">
            or explore the demo →
          </Link>
        </div>
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="relative z-10 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-brand-fg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" /></svg>
            </div>
            <span className="text-sm font-semibold">Nexus Cyber</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-fg/40">
            <span>Commercial &amp; Azure Government</span>
            <span>·</span>
            <span>Microsoft 365 &amp; Graph</span>
            <span>·</span>
            <span>© Nexus Cyber — reference implementation</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
