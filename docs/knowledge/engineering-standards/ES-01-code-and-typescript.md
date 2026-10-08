# ES-01 — Code & TypeScript Standards

| | |
|---|---|
| **Applies to** | `apps/api`, `apps/web`, `scripts/` |
| **Owner** | SBS Federal RD&T — Anchor engineering |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Language and runtime

- **TypeScript everywhere**, `strict: true`. No `any` without a comment explaining why the type cannot be expressed.
- **Node.js 20+** (CI runs 20; the production web app runs Node 22). Do not use APIs newer than Node 20.
- The API is **ES modules** (`"type": "module"`). Relative imports carry the `.js` extension (`import { x } from './pool.js'`) even from `.ts` sources.
- Target `ES2022`, `moduleResolution: Bundler`.

## 2. Repository layout

```
apps/api/src/
  auth/          identity: sessions, OIDC, API keys, password hashing
  authz/         policy decision point (RBAC + ABAC)
  db/            pool, RLS context, migrate, seed, migrations/*.sql
  events/        domain event bus
  http/          routes, request context, idempotency
  integrations/  m365/, entra/ — every Microsoft Graph call lives here
  jobs/          background sweepers and pollers
  modules/       domain logic, one file (or folder) per capability
  scripts/       one-off operational scripts (dry-run by default)
apps/web/
  app/           Next.js App Router routes
  components/ui/ vendored design system (first-party code)
  lib/           API client and shared helpers
```

New domain capability → new file under `modules/`. If it grows a planner, executor and service, promote it to a folder (see `modules/provisioning/`, `modules/offboarding/`).

## 3. Style

- Follow the surrounding code: naming, comment density and idiom. Consistency beats preference.
- **Comments explain *why*, not *what*.** The codebase routinely records the incident or constraint that forced a design (for example the `Errors.preconditionFailed` vs `conflict` note in `errors.ts`). Keep doing that — it is the cheapest form of institutional memory.
- Validate every external input with **zod** at the boundary. Never trust request bodies, Graph responses or webhook payloads to match their declared types.
- Prefer **pure functions** for decision logic (planners, classifiers, SLA math) and keep I/O at the edges. Pure functions are what make the unit tests cheap.
- Use `ulid()` for generated identifiers that need to sort by time.

## 4. Errors

- Throw `ApiError` via the `Errors.*` factories in `apps/api/src/errors.ts`; they render as **RFC 7807** problem documents.
- Use the most specific factory. `conflict` (a run is already in progress) and `preconditionFailed` (the caller's etag/fingerprint is stale) are different signals to the UI — do not collapse them.
- Field-level validation failures go in `errors[]` with `field` + `message` so the UI can highlight the field.

## 5. Logging

- Use the shared **pino** logger (`apps/api/src/logger.ts`). No `console.log` in server code.
- Log structured objects (`logger.error({ err, ticketId }, 'message')`), not interpolated strings.
- **Never log secrets, tokens, passwords, or PII vault contents.** Log identifiers, not values.

## 6. Dependencies

- Add a dependency only when it removes meaningful code or risk. Every package is part of the gov-cloud SBOM.
- No runtime fetches from third-party CDNs (see [ES-08](ES-08-frontend-and-ui.md)).
- High/critical advisories must be fixed or explicitly accepted before release (see [ES-05](ES-05-security-and-tenant-isolation.md)).

## 7. Housekeeping

- Do not commit generated build output (`dist/`, `.next/`, `tsconfig.tsbuildinfo`).
- Folders named `* 2` (for example `auth 2/`) are iCloud sync duplicates, not source. Do not edit or import from them; delete them when found.
