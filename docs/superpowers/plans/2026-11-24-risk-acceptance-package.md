# Risk Acceptance Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Anchor issue a one-organization risk acceptance package (print-ready, saved as PDF) for an Authorizing Official to sign on paper, and record the signed result against the risks with the signed copy attached.

**Architecture:** The API freezes a snapshot of the chosen `requested` risks of one organization, renders it to print-ready HTML with a pure renderer, stores html + sha256 in `risk_acceptance_packages`, and serves the stored html on every reprint. Recording takes a multipart upload (signed copy, reusing attachments storage and scanning) plus per-risk decisions and applies the existing acceptance decision logic in one transaction. The web fetches the html with the bearer token and writes it into a new window that prints on load (the Billing statement pattern).

**Tech Stack:** Fastify 5 + zod + pg (apps/api), Next.js + React (apps/web), vitest, Postgres RLS. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-risk-acceptance-package-design.md`

## Global Constraints

- One organization per package; no other organization's data (names, counts, portfolio figures) in any package html.
- No new npm dependencies (repo standard: no new frameworks/libraries).
- Every new table: RLS with the standard isolation policy `organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id)`, `GRANT SELECT, INSERT, UPDATE, DELETE … TO nexus_app`.
- Forward-only migration `apps/api/src/db/migrations/0092_risk_acceptance_packages.sql`. No new permissions (reuse `risk.read`, `risk.manage`, `risk.accept`), so `seed.ts` is unchanged.
- Existing acceptance rules hold: decisions need `risk.accept`; requester ≠ decider (403 "separation of duties…"); expiry capped by `max_acceptance_days`.
- Package numbers per organization, shown as `AP-0001` (`AP-` + 4-digit zero pad), allocated under `pg_advisory_xact_lock(hashtext('acceptance_package:' || org))`.
- Audit actions: `risk.acceptance_package.issue`, `risk.acceptance_package.export`, `risk.acceptance_package.record`, `risk.acceptance_package.void`.
- History note on each decided risk, exactly: `Signed by <name>, <title> on <YYYY-MM-DD>; package AP-0001 (<first 12 of sha256>)`.
- Work happens on branch `feat/risk-acceptance-package` from `origin/main`, in a git worktree (the shared checkout at /Volumes/developer/NexusCyber_Support has other sessions' work; do not switch its branch). Commit the spec and this plan as the branch's first commit.
- On this SMB checkout `npx` fails ("bad interpreter"). Run tools through node: from `apps/api`, `node ../../node_modules/vitest/vitest.mjs run <file>` and `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`. Integration tests need the dev DB: `docker start nexus-db`, then `set -a; . ../../.env; set +a` (port 5544); they auto-skip without `DATABASE_URL`, so check the output says tests ran, not skipped.

## Review Focus

- **Risk text containing HTML** (imported descriptions, justifications with `<`, `&`, quotes): must print literally, never as markup or script. → Task 1 test `escapes every field`.
- **Two users issuing packages for the same risk at once:** only one package may hold it. → Task 2 test `concurrent issue gives the risk to one package`.
- **A risk closed, re-requested or edited after issue:** recording must refuse rather than accept something the AO did not see. → Task 4 test `refuses when a risk changed after issue` (covers residual, justification, expiry, closed).
- **Staff (nexus plane) calling package routes without `organizationId`:** refused like every other register collection route, never a cross-org list. → Task 2 test `staff must name the organization`.
- **Signed scan too large or of a disallowed type:** a clear 422 from `validateUpload`, nothing recorded. → Task 4 test `rejects an invalid signed copy without recording`.

---

### Task 1: Snapshot type and pure renderer

**Files:**
- Create: `apps/api/src/modules/acceptance-package-render.ts`
- Test: `apps/api/test/acceptance-package-render.test.ts`

**Interfaces:**
- Produces:
  - `interface PackageRiskSnapshot { id: string; ref: string; title: string; cause: string|null; event: string|null; consequence: string|null; category: string; ownerName: string|null; threatSource: string|null; velocity: string|null; inherent: { l: number; i: number; score: number; rating: string }; residual: {…same}; target: {…same}|null; impactDimensions: Record<string, number>; description: string|null; controls: Array<{ id: string; title: string }>; treatments: Array<{ title: string; status: string; dueAt: string|null }>; justification: string; expiresAt: string; requestedBy: string|null; requestedAt: string|null }`
  - `interface PackageSnapshot { organization: { id: string; name: string }; packageNumber: string; reference: string|null; generatedAt: string; generatedBy: string; appetite: number; tolerance: number; risks: PackageRiskSnapshot[] }`
  - `function snapshotSha256(s: PackageSnapshot): string` — sha256 hex of `JSON.stringify(s)` (the snapshot is built with a fixed key order; the hash is taken from the in-memory object at issue time and stored, never recomputed from jsonb, which reorders keys).
  - `function renderPackageHtml(s: PackageSnapshot, sha256: string): string` — deterministic for given inputs (no `Date.now()` inside); prints `sha256.slice(0, 12)` in the footer. (A page cannot contain the hash of itself, so the package hash is the snapshot's: it identifies exactly the data the AO saw.)
  - `function packageNumber(n: number): string` → `'AP-0001'`.

- [ ] **Step 1: Write failing tests** in `test/acceptance-package-render.test.ts` with a two-risk fixture snapshot for org "Quantifind":
  - `packageNumber formats` — `packageNumber(1) === 'AP-0001'`, `packageNumber(123) === 'AP-0123'`.
  - `renders header, summary, one section per risk and a signature block` — html contains `Quantifind`, `AP-0001`, the reference `RA-2026-03` when set and no `Reference` label when `null`; both risk refs; `class="risk"` exactly twice; `Accept until` with each risk's expiry date; signature labels `Name`, `Title`, `Signature`, `Date`.
  - `deterministic` — `renderPackageHtml(s, h) === renderPackageHtml(structuredClone(s), h)`, and `snapshotSha256(s) === snapshotSha256(structuredClone(s))`; changing one risk's justification changes the hash.
  - `footer carries number and short hash` — html contains `AP-0001` and `h.slice(0, 12)`.
  - `escapes every field` — a title `<script>alert(1)</script>`, description `a & b "c"` and justification `<b>x</b>` appear as `&lt;script&gt;…`, `a &amp; b &quot;c&quot;`, `&lt;b&gt;x&lt;/b&gt;`; html contains no `<script>alert`.
  - `prints on load and carries no external resources` — exactly one `<script>` (the `window.print` onload), no `http://`/`https://` URLs, no `<link` or `<img src=`.
- [ ] **Step 2: Run** `node ../../node_modules/vitest/vitest.mjs run test/acceptance-package-render.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `renderPackageHtml` and `packageNumber`. One `esc()` applied to every interpolated value. Each risk section `<section class="risk">` with `break-before: page`; footer text `<packageNumber> · <reference?> · sha256 <first 12> · Page n` via `@page` margin boxes; `@page { size: letter; margin: 0.6in }`; layout styling follows Billing's `openStatement` CSS.
- [ ] **Step 4: Run** the test file — expect PASS; then `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(risks): acceptance package snapshot and renderer`.

### Task 2: Package table, issue, list, reprint, void

**Files:**
- Create: `apps/api/src/db/migrations/0092_risk_acceptance_packages.sql`
- Create: `apps/api/src/modules/acceptance-packages.ts`
- Modify: `apps/api/src/http/routes-risks.ts` (add routes beside `/risks/export.csv`)
- Test: `apps/api/test/integration/acceptance-packages.int.test.ts`

**Interfaces:**
- Consumes: `renderPackageHtml`, `packageNumber`, `PackageSnapshot` (Task 1); `resolveOrg`, `loadSettings` from `risks.ts` (export them).
- Produces:
  - Table `risk_acceptance_packages`: `id uuid pk`, `organization_id uuid not null`, `package_number int not null`, `reference text`, `risk_ids uuid[] not null`, `snapshot jsonb not null`, `html text not null`, `sha256 text not null` (the snapshot hash from `snapshotSha256`), `status text not null check (status in ('issued','signed','void'))`, `void_reason text`, `generated_by uuid`, `generated_at timestamptz not null default now()`, `signed_by_name text`, `signed_by_title text`, `signed_on date`, `recorded_by uuid`, `recorded_at timestamptz`, `signed_attachment_id uuid`, `decisions jsonb`; `unique (organization_id, package_number)`; RLS per Global Constraints.
  - Migration also: `ALTER TABLE attachments ALTER COLUMN ticket_id DROP NOT NULL`, `ADD COLUMN acceptance_package_id uuid REFERENCES risk_acceptance_packages(id) ON DELETE CASCADE`, `ADD CONSTRAINT attachments_one_parent CHECK (num_nonnulls(ticket_id, acceptance_package_id) = 1)`, and the FK `risk_acceptance_packages.signed_attachment_id → attachments(id)`.
  - `issuePackage(actor, input: { organizationId?: string; riskIds?: string[]; reference?: string|null }): Promise<PackageSummary>` — needs `risk.manage`.
  - `listPackages(actor, organizationId?: string): Promise<PackageSummary[]>` — needs `risk.read`.
  - `getPackageHtml(actor, id: string): Promise<{ html: string; packageNumber: string }>` — needs `risk.read`; audits `…export`.
  - `voidPackage(actor, id: string, reason: string): Promise<PackageSummary>` — needs `risk.manage`; only `issued`.
  - `issuedPackageFor(sql, riskId): Promise<{ id: string; packageNumber: string } | null>` — for Task 3.
  - `type PackageSummary = { id; organization_id; number: string; reference; status; risk_ids; sha256; generated_at; generated_by; signed_by_name; signed_by_title; signed_on; recorded_at; signed_attachment_id; decisions }` (no `html`, no `snapshot`).
  - Routes: `GET /api/v1/risks/acceptance-packages?organizationId=` → `{ data }`; `POST /api/v1/risks/acceptance-packages` body `{ organizationId?, riskIds?: uuid[] (1–50), reference?: string ≤ 60 }` → 201; `GET /api/v1/risks/acceptance-packages/:id/html` → `text/html; charset=utf-8`, `Cache-Control: no-store`; `POST /api/v1/risks/acceptance-packages/:id/void` body `{ reason: string 3–500 }`.

- [ ] **Step 1: Write failing integration tests** (pattern: `test/integration/risks.int.test.ts` — `describeDb`, `principalByEmail`, Demo Corp + a second org created in `beforeAll`; requests filed by `analyst`). Tests:
  - `issues a package of the org's requested risks` — two requested risks; `issuePackage(analyst, { organizationId: demoId, reference: 'RA-TEST' })` → `number === 'AP-0001'`, status `issued`, both ids; `getPackageHtml` html contains both refs, `RA-TEST` and `summary.sha256.slice(0, 12)`.
  - `reprint is identical` — after `updateRisk` on one risk, `getPackageHtml` returns byte-identical html.
  - `refuses risks of another organization` — a requested risk of the other org in `riskIds` → 400; other org's name absent from every Demo package html.
  - `refuses risks not awaiting acceptance` — a `treating` risk id → 400.
  - `a risk is in at most one issued package` — second issue with the same risk → 409; after `voidPackage` → succeeds as `AP-0002`.
  - `concurrent issue gives the risk to one package` — `Promise.allSettled` of two `issuePackage` calls on the same risk → exactly one fulfilled, one rejected 409.
  - `staff must name the organization` — staff principal `listPackages(manager)` with no org → 400, same as `listRisks`.
  - `customer of another org cannot list or print` — `otherAdmin` on Demo → 403/404.
  - `audits issue, export and void` — `audit_logs` rows for the three actions.
- [ ] **Step 2: Run** `node ../../node_modules/vitest/vitest.mjs run test/integration/acceptance-packages.int.test.ts` with the dev DB env — expect FAIL.
- [ ] **Step 3: Write the migration** as specified; apply with `node ../../node_modules/tsx/dist/cli.mjs src/db/migrate.ts`.
- [ ] **Step 4: Implement** `acceptance-packages.ts`. `issuePackage` in one org-context transaction: resolve org; take the advisory lock; select the org's risks with `acceptance_status='requested'` (all, or exactly `riskIds` — any missing/other-org/not-requested id → 400 listing them); refuse 409 if any is in an `issued` package; build `PackageSnapshot` from that org only (controls from `risk_links kind='control'`, treatments, settings appetite/tolerance, requester display name); `h = snapshotSha256(snapshot)`; `html = renderPackageHtml(snapshot, h)`; insert snapshot, html, `sha256 = h`; audit. Routes in `routes-risks.ts` with zod as listed.
- [ ] **Step 5: Run** the integration file and `test/integration/risks.int.test.ts` — all pass, none skipped; `tsc` clean.
- [ ] **Step 6: Commit** `feat(risks): issue, list, reprint and void acceptance packages`.

### Task 3: Block direct decisions while a risk is in an issued package

**Files:**
- Modify: `apps/api/src/modules/risks.ts` (`decideAcceptance`)
- Test: `apps/api/test/integration/acceptance-packages.int.test.ts`

**Interfaces:**
- Consumes: `issuedPackageFor(sql, riskId)` (Task 2).
- Produces: `applyAcceptanceDecision(sql: Sql, actor: Principal, cur: any, approve: boolean, note?: string): Promise<any>` exported from `risks.ts` — the body of today's decision (SoD check, UPDATE, history, audit, publish) taking the already-loaded row; `decideAcceptance` = load + authorize + package guard + `applyAcceptanceDecision`.

- [ ] **Step 1: Failing tests:** `direct decide is refused while in an issued package` — `decideAcceptance(manager, id, true)` → 409 with message containing `AP-0001`; `direct decide works again after void` — void, then decide → status `accepted`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the refactor and guard. Existing `risks.int.test.ts` acceptance tests must still pass unchanged.
- [ ] **Step 4: Run** both integration files — PASS; `tsc` clean.
- [ ] **Step 5: Commit** `feat(risks): direct acceptance blocked while awaiting a signed package`.

### Task 4: Record the signed package

**Files:**
- Modify: `apps/api/src/modules/attachments.ts` (add `uploadForPackage`; branch `download` authorization)
- Modify: `apps/api/src/modules/acceptance-packages.ts` (add `recordSignature`)
- Modify: `apps/api/src/http/routes-risks.ts`
- Test: `apps/api/test/integration/acceptance-packages.int.test.ts`

**Interfaces:**
- Consumes: `applyAcceptanceDecision` (Task 3); `blobStore`, `scanner`, `validateUpload` from `storage.ts`.
- Produces:
  - `uploadForPackage(sql: Sql, actor: Principal, input: { packageId: string; organizationId: string; filename: string; contentType: string; bytes: Buffer }): Promise<{ id: string; scan_status: string; sha256: string }>` — runs inside the caller's transaction; storage key `<org>/acceptance-packages/<packageId>/<uuid>`.
  - `download` authorizes `risk.read` when `acceptance_package_id` is set, `ticket.comment` otherwise.
  - `type PackageDecision = 'accepted' | 'not_accepted' | 'not_marked'`.
  - `recordSignature(actor, id: string, input: { signedByName: string; signedByTitle: string; signedOn: string /* YYYY-MM-DD */; decisions: Record<string /* riskId */, PackageDecision>; file: { filename: string; contentType: string; bytes: Buffer } }): Promise<PackageSummary>` — needs `risk.accept`.
  - Route `POST /api/v1/risks/acceptance-packages/:id/record` multipart: file field `file`; text field `payload` = JSON `{ signedByName (2–200), signedByTitle (2–200), signedOn (date), decisions }`.

- [ ] **Step 1: Failing tests:**
  - `records accepted, not accepted and not marked` — 3-risk package; `recordSignature(manager, …)` with one of each → package `signed` with name/title/date/attachment; accepted risk `status='accepted'`, `acceptance_decided_by=manager`; not-accepted risk `acceptance_status='rejected'`; not-marked risk still `requested` and issuable into a new package; each decided risk's latest history note equals `Signed by Jane Doe, Authorizing Official on 2026-12-01; package AP-0001 (<sha12>)`.
  - `requires a decision for every risk` — a missing risk id or an id not in the package → 400; nothing changed.
  - `refuses when a risk changed after issue` — cases: residual reassessed, justification re-requested, expiry changed, risk closed → 409 naming the risk; nothing changed.
  - `refuses an expired or late-signed acceptance` — accepted risk whose expiry is past → 409; `signedOn` after its expiry → 409.
  - `separation of duties` — `analyst` (requester, and no `risk.accept`) → 403; a `risk.accept` user who requested one of the accepted risks → 403.
  - `rejects an invalid signed copy without recording` — disallowed content type / oversize → 422; missing file → 400; scanner returning `infected` → 409; package still `issued`, no attachment row kept.
  - `refuses a package that is not issued` — signed or void → 409.
  - `signed copy downloads with risk.read` — `attachments.download(analyst, attId)` succeeds; `otherAdmin` → 404.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `uploadForPackage`, the `download` branch, `recordSignature` (one org-context transaction: load package FOR UPDATE; checks in the order the tests list; for each risk compare current `residual_score`, `acceptance_justification`, `acceptance_expires_at`, `acceptance_status='requested'`, `status<>'closed'` with the snapshot; upload + require `scan_status='clean'`; `applyAcceptanceDecision` for accepted/not-accepted with the note; update package; audit). Throwing rolls back the attachment row; also `blobStore.delete` the key on failure if `BlobStore` has a delete, else leave the orphan blob (unreferenced, never served) and note it in a code comment. The multipart route uses `(req as any).parts()` to read `file` and `payload`.
- [ ] **Step 4: Run** all integration and unit tests in `apps/api` — PASS, none skipped; `tsc` clean.
- [ ] **Step 5: Commit** `feat(risks): record a signed acceptance package with the signed copy`.

### Task 5: Web — packages panel, generate and print

**Files:**
- Modify: `apps/web/lib/risks.ts` (types + `risksApi` methods)
- Create: `apps/web/app/(app)/risks/_components/acceptance-packages.tsx`
- Modify: `apps/web/app/(app)/risks/page.tsx` (button beside Export CSV, around line 160)

**Interfaces:**
- Consumes: Task 2 and Task 4 routes.
- Produces in `lib/risks.ts`: `type AcceptancePackage` (mirrors `PackageSummary`); `risksApi.packages(orgId)`, `risksApi.issuePackage(orgId, riskIds, reference)`, `risksApi.voidPackage(id, reason)`, `risksApi.recordPackage(id, payload, file: File)` (multipart via `fetch` + bearer token, as `exportCsv` does), `risksApi.openPackage(id): Promise<void>` (fetch html with bearer token; `window.open('', '_blank')`; `document.open/write/close`; if the popup is blocked, throw `ApiError(0, 'Allow pop-ups for Anchor to print the package')`).
- Produces component `AcceptancePackagesPanel({ organizationId, canManage, canAccept, risks, onChanged })`.

- [ ] **Step 1: Implement** the api methods and the panel: a dialog listing packages (number, reference, status badge, risk count, generated date, signed by/on) with row actions Reprint, Record signature (Task 6), Void (`canManage`, issued only, reason prompt), Download signed copy (signed only, via existing `/attachments/:id`). **Generate package** (`canManage`): requested risks of the current org not already in an issued package, all ticked, optional Reference input; create then `openPackage`. Empty state when no risk awaits acceptance: "No risks are awaiting acceptance. Request acceptance on a risk first." The button on the Risks page shows only when a single organization is selected.
- [ ] **Step 2: Verify** from `apps/web`: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` clean; run the web and API locally (dev DB), request acceptance on two Demo Corp risks, generate a package, confirm the print dialog opens with both risks, one per page, header `AP-0001`.
- [ ] **Step 3: Commit** `feat(web): generate and print risk acceptance packages`.

### Task 6: Web — record signature and risk detail

**Files:**
- Modify: `apps/web/app/(app)/risks/_components/acceptance-packages.tsx` (record dialog)
- Modify: `apps/web/app/(app)/risks/_components/risk-detail.tsx` (`AcceptanceTab`, ~line 303)
- Modify: `apps/api/src/modules/risks.ts` (`getRisk` returns `acceptance_packages: Array<{ id; number; status; signed_by_name; signed_on; signed_attachment_id }>`)
- Test: `apps/api/test/integration/acceptance-packages.int.test.ts` (`getRisk lists its packages`)

**Interfaces:**
- Consumes: `risksApi.recordPackage` (Task 5); `issuedPackageFor` semantics (Task 3).

- [ ] **Step 1: Failing API test** `getRisk lists its packages` — after issue, `getRisk(analyst, id).acceptance_packages[0]` has `number 'AP-0001'`, status `issued`; after record, status `signed` and `signed_by_name`.
- [ ] **Step 2: Implement** the `getRisk` addition; run the test — PASS.
- [ ] **Step 3: Implement** the record dialog (`canAccept`): file input (accept `application/pdf,image/png,image/jpeg`), AO name, title, signed date (default empty), one row per risk with three radios Accepted / Not accepted / Not marked and no default; submit disabled until every row and field is set; server errors shown inline. AcceptanceTab: when the risk is in an issued package, replace Approve/Reject with "Awaiting signed acceptance package AP-0001" and hide the buttons; when signed, show "Signed by <name>, <title> on <date> · AP-0001" and a download link to the signed copy.
- [ ] **Step 4: Verify** web `tsc` clean; locally record the package from Task 5 with a PDF, one Accepted and one Not marked; confirm the accepted risk shows Accepted with the signer line, the other shows Request pending again with Approve available.
- [ ] **Step 5: Commit** `feat(web): record signed acceptance packages; show package status on risks`.

### Task 7: Branch review and PR

- [ ] **Step 1:** Run all `apps/api` unit and integration tests and both `tsc` checks; all pass, integration not skipped.
- [ ] **Step 2:** Push `feat/risk-acceptance-package`; open a PR to `main` summarizing the spec, migration 0092, and test results. Do not merge or deploy without the user's go-ahead.
