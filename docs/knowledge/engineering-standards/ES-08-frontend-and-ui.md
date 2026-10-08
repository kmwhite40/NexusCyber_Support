# ES-08 — Frontend & UI Standards

| | |
|---|---|
| **Applies to** | `apps/web` |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Stack

Next.js 15 (App Router), React 18, Tailwind CSS 3, Radix primitives, `lucide-react` icons, framer-motion for motion, Vitest + Testing Library.

## 2. No runtime third-party fetches

Anchor runs in a government enclave. The browser must not call anything except Anchor's own origins.

- UI components from 21st.dev / shadcn are **vendored** into `apps/web/components/ui/` and maintained as first-party code.
- Fonts, logos and images are served locally. No Google Fonts, no CDN scripts, no remote images.
- Icons come from bundled `lucide-react`.

## 3. Components

- Build screens from the design system in `components/ui/` (`primitives.tsx`, `data.tsx`, `charts.tsx`, `badges.tsx`) before creating new primitives.
- **One failing card must not take down a page.** Render per-card data defensively (null-safe access, local error boundaries). See `f28d914`.
- Long forms are grouped into **sections**; field visibility rules must match the server's (`form-visibility-parity.test.ts`).

## 4. Accessibility

- Every interactive control is a real `<button>`/`<a>`/input with an accessible name.
- Form fields have associated labels and announce errors (`field-a11y.test.tsx`).
- Dialogs trap focus and close on Escape (Radix Dialog does this — don't hand-roll modals).
- Respect `prefers-reduced-motion` for decorative animation such as the GLSL hero.

## 5. Data and API

- Call the API through `apps/web/lib`, never with ad-hoc `fetch` in components.
- Surface RFC 7807 `errors[]` against the matching field, not as a generic toast.
- Show the user the outcome of destructive or tenant-changing actions (dry-run preview first, explicit confirm, result state after).

## 6. Testing

Component tests for every panel that makes decisions (vote tallies, form visibility, provisioning preview). Query by role and name.
