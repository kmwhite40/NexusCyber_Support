# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the marketing-style landing page with a calm, modern three-block page (hero / pillar strip / one-line footer) while keeping the animated `GLSLHills` cloud hero.

**Architecture:** Single-file rewrite of `apps/web/app/page.tsx`. Reuse existing vendored components (`GLSLHills`, `Navbar1`) and the `Button` primitive. Remove now-unused sections (display cards, feature grid, stats band, CTA, large footer) and their imports. No new files, no new dependencies.

**Tech Stack:** Next.js (App Router), React 18, TypeScript (strict), Tailwind CSS, lucide-react. Package manager: npm. Verification via `tsc --noEmit` + `next build`; this is a visual change with no component-test harness, so correctness is gated by a clean typecheck/build plus a manual smoke check (the repo has no React test runner configured).

**Spec:** `docs/superpowers/specs/2026-06-11-landing-page-redesign-design.md`

---

## File Structure

- Modify (full rewrite): `apps/web/app/page.tsx` — the only file changed.

The following components are **kept and imported** as-is: `@/components/ui/glsl-hills` (`GLSLHills`), `@/components/ui/navbar1` (`Navbar1`), `@/components/ui/primitives` (`Button`), `@/components/auth-context` (`useAuth`), `@/lib/api` (`homePath`), plus `ArrowRight` from `lucide-react`.

The following stay in the repo but are **no longer imported by this page** (may be used elsewhere — do not delete the files): `display-cards`, `liquid-glass-button`, the large `footer`, `brand` (`BrandMark`), and `Card`/`CardBody`/`Badge` from `primitives`.

---

### Task 1: Rewrite the landing page

**Files:**
- Modify (replace entire contents): `apps/web/app/page.tsx`

- [ ] **Step 1: Record the current passing baseline**

Confirm the page typechecks before changing it, so any later failure is attributable to this task.

Run: `cd apps/web && npx tsc --noEmit`
Expected: completes with no errors (exit 0).

- [ ] **Step 2: Replace the entire contents of `apps/web/app/page.tsx`**

Replace the whole file with exactly this:

```tsx
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
  { name: 'Docs', href: '#' },
  { name: 'Status', href: '#' },
  { name: 'Privacy', href: '#' },
];

const navData = {
  logo: { url: '/', src: '/nexus-mark.svg', alt: 'Nexus Cyber', title: 'Nexus Cyber' },
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
          <span>NexusCyber © 2026</span>
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
```

- [ ] **Step 3: Typecheck (catches unused imports / type errors)**

Run: `cd apps/web && npx tsc --noEmit`
Expected: completes with no errors. If it reports an unused import, you left an import from the old page — remove it. The import list in Step 2 is the complete and only set of imports this file should have.

- [ ] **Step 4: Production build**

Run: `cd apps/web && npm run build`
Expected: build succeeds; `/` is compiled with no errors or lint failures.

- [ ] **Step 5: Manual smoke check**

Run: `cd apps/web && npm run dev`, then open `http://localhost:3000`.
Confirm:
- Animated clouds render behind the hero.
- Headline shows "The cyber operations" over a lighter-weight "control plane".
- Two buttons render: solid "Get started" and outline "Sign in".
- Compliance line appears under the hero.
- One row of three columns (ITSM / On-call / Posture) appears below the hero; they stack vertically when the window is narrowed.
- One-line footer with copyright + four links.
- Click "Get started" → navigates to `/signup`; "Sign in" → `/login`.
- None of the removed sections (stats band, eight-card grid, hover display cards, large multi-column footer) appear.

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
cd /Users/kevinwhite/Documents/NexusCyber_Support
git add apps/web/app/page.tsx
git commit -m "feat(web): simplify landing page to calm three-block layout

Remove marketing sections (display-card pillars, feature grid, stats band,
CTA, multi-column footer) in favor of hero + plain pillar strip + one-line
footer. Keep the GLSLHills animated cloud hero and Navbar1. Switch hero CTAs
to the standard Button primitive.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Keep clouds → Step 2 imports and renders `GLSLHills` ✓
- Keep navbar + auth redirect → `Navbar1` + `useEffect` redirect retained ✓
- Remove display cards / feature grid / stats / CTA / big footer → none present in new file; Task 1 intro lists them as no-longer-imported ✓
- Hero: single-weight headline + muted second line, one sentence, primary + secondary buttons, compliance line → Step 2 hero block ✓
- Pillar strip: three plain-text columns, hairline dividers, responsive stack → Step 2 pillar section (`divide-*`, `grid-cols-1 md:grid-cols-3`) ✓
- Minimal one-line footer with a few links → Step 2 footer block ✓
- No new deps; glsl-hills integration already satisfied → no install steps ✓
- Cleanup of unused imports → Step 3 typecheck enforces it ✓
- Verification (typecheck/build/manual) → Steps 3–5 ✓

**2. Placeholder scan:** No TBD/TODO; full file contents and exact commands provided. (`href: '#'` for Docs/Status/Privacy is intentional — those destinations don't exist yet, matching the prior page's placeholder hrefs.)

**3. Type consistency:** `Button` used with `variant="outline"` and `size="lg"`, both valid per the primitive's union types (`variant?: 'default' | 'outline' | ...`, `size?: 'sm' | 'md' | 'lg' | 'icon'`). `navData` shape matches what the existing page passed to `Navbar1`. All Tailwind tokens used (`bg-bg`, `border-border`, `bg-surface`, `text-fg`, `text-fg/NN`) are already used elsewhere in the current page.
