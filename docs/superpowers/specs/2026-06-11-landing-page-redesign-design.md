# Landing Page Redesign — Simple & Modern

**Date:** 2026-06-11
**Status:** Approved (design), pending spec review
**Scope:** `apps/web/app/page.tsx` (the public landing page only)

## Goal

Make the landing page read as a calm, modern product page rather than a
marketing/sales pitch. Keep the animated WebGL cloud background (the existing
`GLSLHills` component). Strip the sales-y scaffolding.

## What changes

The current page is a long marketing page: shader hero → three hover-animated
"pillar" display cards → eight-card feature grid → big-number stats band → CTA
section → three-column footer. The redesign collapses this to three calm blocks.

### Keep
- The animated cloud hero background (`GLSLHills`) — unchanged component.
- The existing navbar (`Navbar1`) and `navData`.
- The auth redirect logic (`useEffect` → `homePath(me.plane)`).
- Brand tokens / color palette already in the app.

### Remove
- The three `DisplayCards` "pillars" section (hover-translate animated cards).
- The eight-card `FEATURES` grid section.
- The `STATS` band (big gradient numbers).
- The standalone CTA section ("Stand up your control plane.").
- The large three-column `Footer` with Platform/Solutions/Company link columns.

### Result — three blocks

1. **Hero** (full viewport, clouds behind)
   - Navbar (unchanged).
   - Single-weight headline, modern and quiet:
     `The cyber operations` / `control plane` (second line as a muted/secondary
     weight, not a multi-color gradient).
   - One supporting sentence (reuse current copy):
     "ITSM, on-call response, and continuous security posture — isolated per
     customer, ready for Commercial and Government clouds."
   - Two buttons: a solid **primary** "Get started" (→ `/signup`) and a quiet
     **secondary** "Sign in" (→ `/login`). Drop the liquid-glass/metal button
     pairing in favor of two clean buttons; the primary is high-contrast.
   - Thin compliance line (uppercase, low-emphasis), reused:
     `NIST 800-53 · CMMC 2.0 · FedRAMP · SOC 2 · ISO 27001`.

2. **Pillar strip** (one restrained row, no animation, no cards)
   - Three plain-text columns separated by hairline dividers:
     - **ITSM & ITIL** — "Incidents, requests, change & problem — one queue."
     - **On-call & incident** — "Rotations, paging, escalation — one severity model."
     - **Security posture** — "Findings to evidence — a system of record."
   - Stacks vertically on mobile, three columns on `md+`.

3. **Minimal footer** (one line)
   - Left: `NexusCyber © 2026`.
   - Right: a few quiet text links (GitHub, Docs, Status, Privacy).
   - Replaces the large multi-column `Footer`. The heavy `Footer` component
     stays in the repo (may be used elsewhere) but is no longer imported here.

## Visual direction

- Single-weight, tight-tracking headline; secondary line in a muted weight
  instead of the current thin-italic + tri-color gradient treatment.
- High-contrast solid primary button; understated secondary.
- Generous vertical whitespace; fewer badges. The "Multi-tenant · GCC High
  ready · Posture-native" badge is dropped (sales-y); compliance line carries
  the trust signal.
- No hover-translate card choreography anywhere on the page.

## Non-goals

- No change to `GLSLHills`, `Navbar1`, auth, routing, or design tokens.
- No new dependencies. (`three` is already installed; the "integrate
  glsl-hills" request is already satisfied by the existing vendored component
  and is not re-done here.)
- No copy rewrite beyond trimming; reuse existing sentences where possible.
- Other pages (`/login`, `/signup`) are out of scope for this spec.

## Cleanup implications

After the edit, several imports in `page.tsx` become unused and must be
removed to keep the strict build clean: `DisplayCards`, the `PILLAR_CARDS` /
`FEATURES` / `STATS` constants, `LiquidButton` / `MetalButton`, `Card` /
`CardBody` / `Badge` (unless reused for the new buttons), and most `lucide-react`
icons. Keep only what the new three-block page references.

## Testing / verification

- `pnpm --filter web build` (or repo equivalent) compiles with no unused-import
  or type errors.
- Manual: load `/`, confirm clouds animate, headline + two buttons render, the
  three-column strip and one-line footer appear, layout is responsive at
  mobile / `md` / `lg`, and "Get started" → `/signup`, "Sign in" → `/login`.
