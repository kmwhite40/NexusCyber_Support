# Anchor / Nexus Platform — Commit & Push Report

**Repository:** `kmwhite40/NexusCyber_Support`  
**Report generated:** 2026-10-08  
**Period covered:** 2026-06-11 (initial commit) → 2026-09-30 (latest commit)  
**Sources:** local `git log` (all branches) and the GitHub repository activity API (push / merge / branch events).

## Summary

| Metric | Value |
|---|---|
| Total commits (all branches) | 409 |
| Commits on `main` | 407 |
| Lines added / removed | +113,776 / −8,266 |
| Push events to GitHub | 144 |
| Pull requests merged | 2 |
| Branches created on GitHub | 3 |
| Active development days | 13 |
| Author | kmwhite40 (all commits) |

### Commits by type

| Type | Count |
|---|---|
| `feat` | 209 |
| `fix` | 118 |
| `docs` | 42 |
| `chore` | 11 |
| `other` | 9 |
| `ci` | 7 |
| `test` | 5 |
| `ops` | 2 |
| `style` | 2 |
| `Merge` | 2 |
| `infra` | 1 |
| `refactor` | 1 |

### Commits by month

| Month | Commits | Pushes |
|---|---|---|
| 2026-06 | 225 | 69 |
| 2026-09 | 184 | 75 |

### Top areas (commit scopes)

| Scope | Commits |
|---|---|
| `web` | 51 |
| `provisioning` | 32 |
| `offboarding` | 22 |
| `m365` | 17 |
| `forms` | 16 |
| `tickets` | 12 |
| `entra` | 12 |
| `changes` | 11 |
| `db` | 10 |
| `retention` | 10 |
| `kb` | 8 |
| `dashboards` | 8 |
| `deploy` | 8 |
| `mail` | 8 |
| `scripts` | 8 |

## Milestones

| Date (UTC) | Event |
|---|---|
| 2026-06-11 19:41 | Branch `main` created on GitHub at `531a6c6` |
| 2026-06-11 21:49 | Branch `feat/nexus-platform` created on GitHub at `e2e7c7c` |
| 2026-06-12 03:18 | [PR #1](https://github.com/kmwhite40/NexusCyber_Support/pull/1) *Feat/nexus platform* opened |
| 2026-06-12 04:01 | PR #1 merged into `main` (`531a6c6` → `7508d74`) — first runnable platform on `main` |
| 2026-06-25 19:06 | [PR #2](https://github.com/kmwhite40/NexusCyber_Support/pull/2) *Anchor: ServiceNow-parity Phases 1–4, KB build-out, virtual agent & experience layer* opened |
| 2026-09-02 12:50 | Branch `hotfix/ticket-number-race` created on GitHub at `98ae7ef` |
| 2026-09-03 12:48 | PR #2 merged into `main` |
| 2026-09-03 12:51 | Development switches to direct pushes on `main` |
| 2026-09-30 14:50 | Latest push to `main` (`3d1041c`) |

## Branch status (as of report date)

| Branch | State |
|---|---|
| `main` | In sync with `origin/main` (`3d1041c`) |
| `feat/nexus-platform` | Fully merged into `main` (PR #2) |
| `hotfix/ticket-number-race` | 2 commits not on `main` by hash, but equivalent patches already landed on `main` (`708b7ff`, related fixes) — safe to delete |
| `feat/cmdb-device-sync` | Local only, no unique commits — safe to delete |

## Push log

Every push recorded by GitHub, oldest first, with the commits each push delivered.

**Push 1** — 2026-06-11 22:00:08 UTC → `feat/nexus-platform` (`e2e7c7c`..`1a63138`, 1 commit)
- `1a63138` feat: enterprise hardening — on-call engine, tests, CI, security middleware

**Push 2** — 2026-06-12 03:23:51 UTC → `feat/nexus-platform` (`1a63138`..`fead6e8`, 1 commit)
- `fead6e8` feat: automation engine, idempotency, fix missing approvals table

**Push 3** — 2026-06-12 03:36:24 UTC → `feat/nexus-platform` (`fead6e8`..`4a143e6`, 2 commits)
- `74d32fe` chore: vendor Superpowers skills (v5.1.0) into .claude/
- `4a143e6` fix(oncall): resolve responders via system context; parametrize DB host port

**Push 4** — 2026-06-12 03:53:57 UTC → `feat/nexus-platform` (`4a143e6`..`d46d146`, 2 commits)
- `e030e95` docs: design spec for Nexus MVP-completion & enterprise hardening
- `d46d146` feat: customer support portal, on-call rotation config, neutral+blue palette

**Push 5** — 2026-06-12 03:59:25 UTC → `feat/nexus-platform` (`d46d146`..`86a4105`, 1 commit)
- `86a4105` feat(brand): recreate NexusCyber circuit logo; add favicon; use across platform

**Push 6** — 2026-06-12 04:07:38 UTC → `feat/nexus-platform` (`86a4105`..`732c39e`, 3 commits)
- `4d2ce49` docs: Tier 1 (security & compliance) implementation plan
- `11d601e` test: add skip-if-no-DB integration-test scaffolding
- `732c39e` feat(ui): vendored Footer + split-screen auth pages (FloatingPaths)

**Push 7** — 2026-06-12 04:16:31 UTC → `feat/nexus-platform` (`732c39e`..`31f8d8c`, 3 commits)
- `2536ddf` feat(compliance): control coverage, evidence export, posture exception SoD flow
- `15f4fe5` docs: M365 GCC integration design spec (notifications + ingestion)
- `31f8d8c` feat(audit): SIEM export (NDJSON/CEF) + hash-chain verification

**Push 8** — 2026-06-12 04:27:03 UTC → `feat/nexus-platform` (`31f8d8c`..`0bf0062`, 7 commits)
- `5a1df7f` feat(elevation): JIT privilege elevation + break-glass; deterministic audit ordering
- `f9e1bee` docs: landing page redesign (simple & modern) design spec
- `76ba1a4` docs: M365 GCC integration implementation plan (4 tiers)
- `e948a67` feat(attachments): secure upload/scan/scoped-download + concurrency-safe audit chain
- `fefa59d` ci: Postgres service for integration tests + CodeQL, SBOM, dependency review; docs
- `390913c` fix(automation): write add_internal_note to ticket_comments (internal), not a nonexistent table
- `0bf0062` feat(m365): add M365 GCC config block + parser

**Push 9** — 2026-06-12 04:39:14 UTC → `feat/nexus-platform` (`0bf0062`..`0ff7177`, 7 commits)
- `e7344c5` feat(m365): client-credentials token provider with caching
- `a303dc0` feat(m365): Graph HTTP client with throttle/retry
- `4572dd6` feat(m365): notification adapter interface + console dev adapter
- `173e87d` feat(kb): Confluence-style knowledge base + canonical audit hashing
- `cd2ba18` feat(m365): migration for prefs, integration state, health, delivery columns
- `4060701` feat(m365): per-event notification templates
- `0ff7177` feat(tickets): linking + merge (JSM-style related issues)

**Push 10** — 2026-06-12 04:43:08 UTC → `feat/nexus-platform` (`0ff7177`..`bb9cd70`, 3 commits)
- `569b5a2` feat(m365): resolve notification recipients from domain context
- `321dc94` feat(m365): Graph email + Teams adapter
- `bb9cd70` feat(changes): change management + CAB with multi-step approvals & calendar

**Push 11** — 2026-06-12 04:44:10 UTC → `feat/nexus-platform` (`bb9cd70`..`338efd6`, 1 commit)
- `338efd6` chore(brand): copyright punctuation — NexusCyber. A Strategic Business Systems Company.

**Push 12** — 2026-06-12 04:44:48 UTC → `feat/nexus-platform` (`338efd6`..`4e6e4bd`, 2 commits)
- `c8efc4d` feat(m365): real dispatcher (recipients + render + send + record)
- `4e6e4bd` chore(brand): update copyright — operated as part of Strategic Business Systems, Inc.

**Push 13** — 2026-06-12 05:06:02 UTC → `feat/nexus-platform` (`4e6e4bd`..`48f39a9`, 13 commits)
- `8b3b259` feat(problems): ITIL problem management with known-error + incident clustering
- `41746fe` fix(m365): Teams posts once per dispatch; runtime retries on transient error; per-channel skipped records
- `1c13b20` feat(csat): satisfaction surveys on ticket resolution
- `43949b4` feat(m365): inbound mail ingestion (delta fetch + message->ticket)
- `4bf9f3e` feat(queues): saved agent work queues with SLA-aware sorting (JSM parity)
- `9c45a30` feat(m365): mail-ingest scheduler wired into server
- `08e3af9` feat(m365): integration health probes + test service
- `4fc286f` docs: Jira-parity feature build design spec
- `98140ca` feat(m365): health + test integration routes
- `926586a` feat(observability): Prometheus /metrics + README; finalize JSM/Confluence parity
- `561f064` docs(m365): README notes for GCC notifications + dev transport
- `505bbcc` fix(m365): HTML-escape user data in notification email/Teams bodies
- `48f39a9` docs: Jira-parity Phase 1 implementation plan (wire-ups)

**Push 14** — 2026-06-12 05:20:13 UTC → `feat/nexus-platform` (`48f39a9`..`98b007a`, 8 commits)
- `9b1838b` feat(authz): add queue.read/service/org/notifications permissions + grants
- `fd1f9b4` feat(sla): pause/resume + holiday calendars (Tier-2 WP6)
- `6b95dce` feat(cmdb): services + configuration-items API, client, and /services page
- `220266c` feat(worklogs): ticket time tracking (JSM parity)
- `5d50624` feat(automation): gated-action approvals (Tier-2 WP8)
- `d4647b1` feat(canned): reusable canned responses with placeholder rendering (JSM parity)
- `3f6a71c` fix(cmdb): validate service POST bodies, align kind default, label criticality
- `98b007a` fix(m365): resolve specific responder for oncall notifications

**Push 15** — 2026-06-12 05:24:31 UTC → `feat/nexus-platform` (`98b007a`..`7367111`, 4 commits)
- `67b1dbf` feat(tickets): bulk actions (JSM parity)
- `248daaf` feat(customers): org detail/update/users API, client, and /customers page
- `9ccc3da` feat(tickets): participants/watchers + @mentions (JSM A10)
- `7367111` feat(ops): runbook scripts (smoke, db backup/restore) + REST API collection

**Push 16** — 2026-06-12 12:54:21 UTC → `feat/nexus-platform` (`7367111`..`761c646`, 9 commits)
- `3235a46` feat(workflows): configurable ticket status workflows (JSM A7)
- `2840ae7` fix(tickets): serialize ticket-number allocation under concurrency
- `1f7a515` fix(customers): enum-validate cloud, return safe org columns, surface detail load errors
- `e0162ec` feat(notifications): delivery log query API, client, and /email-logs page
- `fc2e674` fix(notifications): validate/clamp deliveries query limit (prevent LIMIT -1 bypass)
- `b7fbf6b` feat(incidents): /incidents view (tickets filtered to type=incident)
- `8001f80` feat(nav): surface incidents, services, customers, email-logs in agent nav
- `8ada8be` fix(phase1): wire ticket type filter, authorize service reads, allow org.read to list orgs
- `761c646` ci(docker): build, smoke-test, and publish container images to GHCR

**Push 17** — 2026-06-12 13:58:43 UTC → `feat/nexus-platform` (`761c646`..`987be77`, 20 commits)
- `4605150` feat(forms): custom request forms & field validation (JSM A4)
- `d7e5cba` docs: Jira-parity Phase 2 implementation plan (alerts, channels, dashboards)
- `a83cc37` feat(authz): add alert/channel/dashboard permissions + grants
- `6d1e0de` feat(alerts): alerts table + RLS + open-alert dedup index
- `3481d2b` feat(alerts): alert state-machine + tests
- `f5027a4` feat(announcements): portal announcements + idempotency fixes
- `9a2d8cf` feat(alerts): ingest/ack/resolve/escalate API, client, and /alerts feed
- `47620ec` fix(alerts): explicit column lists (drop SELECT */RETURNING *)
- `3fff542` feat(channels): channels table + RLS
- `aad157f` feat(channels): channel CRUD API, client, and /channels page
- `54f447c` feat(dashboards): dashboards table + RLS + seeded default per org
- `409da71` feat(dashboards): named dashboards CRUD + widget catalog API, client, and /dashboards page
- `f0eb02e` feat(nav): surface alerts, channels, dashboards in agent nav
- `f4afaf0` docs: Jira-parity Phase 3 implementation plan (IA/nav)
- `206a3e4` feat(get-started): in-app quick-start surface
- `9722a8b` feat(archived): closed/archived work items view
- `dbcc3a6` feat(nav): group agent sidebar into Work/Operations/Insights/Security sections; add Get started + Archived
- `009766d` fix(nav): allow the longer sectioned sidebar to scroll (overflow-y-auto)
- `c4650ea` fix(authz): grant ticket.create to ServiceDeskManager so alert escalation can open a ticket
- `987be77` feat(deploy): Azure Government App Service (Web Apps for Containers) deployment

**Push 18** — 2026-06-12 14:07:25 UTC → `feat/nexus-platform` (`987be77`..`43fd01d`, 1 commit)
- `43fd01d` fix(db): resolve admin-pool deadlock in auth path (blank catalog/hung requests)

**Push 19** — 2026-06-12 14:13:09 UTC → `feat/nexus-platform` (`43fd01d`..`b5b7100`, 1 commit)
- `b5b7100` feat(catalog): add M365/Azure/AWS gov-cloud service catalog items

**Push 20** — 2026-06-12 14:25:42 UTC → `feat/nexus-platform` (`b5b7100`..`d05ffbe`, 1 commit)
- `d05ffbe` feat(deploy): support Azure App Service "Code" (Node 20-LTS) deploy + workflow

**Push 21** — 2026-06-12 14:42:10 UTC → `feat/nexus-platform` (`d05ffbe`..`6764769`, 1 commit)
- `6764769` ci(deploy): build apps/web in CI for Azure Code deploy (reliable on F1)

**Push 22** — 2026-06-12 14:42:47 UTC → `feat/nexus-platform` (`6764769`..`c2e2a5d`, 1 commit)
- `c2e2a5d` ci(deploy): drop GitHub Environment gate from web deploy workflow

**Push 23** — 2026-06-12 14:55:38 UTC → `feat/nexus-platform` (`c2e2a5d`..`bf2c3eb`, 1 commit)
- `bf2c3eb` ci(deploy): use Entra OIDC for web deploy (gov disables basic auth)

**Push 24** — 2026-06-12 15:49:31 UTC → `feat/nexus-platform` (`bf2c3eb`..`5d7c280`, 1 commit)
- `5d7c280` infra(azure-gov): add API-only bicep for Anchor backend (KV-free, gov-policy-compliant)

**Push 25** — 2026-06-12 15:52:21 UTC → `feat/nexus-platform` (`5d7c280`..`07583cc`, 1 commit)
- `07583cc` docs(auth): scope Entra ID (Azure Gov) OIDC for the agent plane

**Push 26** — 2026-06-12 16:02:03 UTC → `feat/nexus-platform` (`07583cc`..`ac42aa6`, 1 commit)
- `ac42aa6` feat(auth): Entra ID (Azure Gov) OIDC for the agent plane (Phase 1, disabled by default)

**Push 27** — 2026-06-12 17:03:23 UTC → `feat/nexus-platform` (`ac42aa6`..`6921aa6`, 1 commit)
- `6921aa6` docs(auth): add customer multi-tenant Entra OIDC plan + config guide

**Push 28** — 2026-06-12 17:13:55 UTC → `feat/nexus-platform` (`6921aa6`..`7a4e5b4`, 1 commit)
- `7a4e5b4` feat(auth): Phase 2 — multitenant customer Entra OIDC (disabled by default)

**Push 29** — 2026-06-12 18:08:53 UTC → `feat/nexus-platform` (`7a4e5b4`..`1609fb3`, 1 commit)
- `1609fb3` feat(api): admin create-org endpoint to onboard customer tenants for SSO

**Push 30** — 2026-06-12 18:13:50 UTC → `feat/nexus-platform` (`1609fb3`..`0365822`, 1 commit)
- `0365822` fix(auth): surface the rejected tenant id in the customer-SSO not-onboarded error

**Push 31** — 2026-06-12 18:33:26 UTC → `feat/nexus-platform` (`0365822`..`63e5a5b`, 1 commit)
- `63e5a5b` feat(api): admin DELETE /organizations/:id (refuses if org has users)

**Push 32** — 2026-06-12 18:35:48 UTC → `feat/nexus-platform` (`63e5a5b`..`5e5dd29`, 1 commit)
- `5e5dd29` feat(web): Microsoft logo on the two SSO buttons (agent + customer)

**Push 33** — 2026-06-12 18:39:23 UTC → `feat/nexus-platform` (`5e5dd29`..`c582749`, 1 commit)
- `c582749` feat(web): rename agent SSO button to "Sign in as Anchor staff"; drop signup link

**Push 34** — 2026-06-12 18:43:46 UTC → `feat/nexus-platform` (`c582749`..`ee5d565`, 1 commit)
- `ee5d565` feat(web): real Terms of Service and Privacy Policy pages

**Push 35** — 2026-06-12 18:49:23 UTC → `feat/nexus-platform` (`ee5d565`..`4011774`, 1 commit)
- `4011774` fix(api): make admin org-delete clear non-cascade child rows first

**Push 36** — 2026-06-12 18:52:17 UTC → `feat/nexus-platform` (`4011774`..`268c3f5`, 1 commit)
- `268c3f5` feat(notifications): make email a supported channel for GCC

**Push 37** — 2026-06-12 18:55:39 UTC → `feat/nexus-platform` (`268c3f5`..`9f14f76`, 1 commit)
- `9f14f76` feat(auth): SuperAdmin role + platform-admin bootstrap; superuser is cross-org; rename SSO button to "Sign in as Admin"

**Push 38** — 2026-06-12 19:00:16 UTC → `feat/nexus-platform` (`9f14f76`..`51b628c`, 1 commit)
- `51b628c` feat(notifications): event-aware recipient routing (agents on new ticket, customer on updates)

**Push 39** — 2026-06-12 19:12:19 UTC → `feat/nexus-platform` (`51b628c`..`37bc980`, 1 commit)
- `37bc980` feat(notifications): new tickets notify a shared desk mailbox, not every agent

**Push 40** — 2026-06-12 19:20:59 UTC → `feat/nexus-platform` (`37bc980`..`4cd5567`, 2 commits)
- `dd1a318` feat(demo): single Demo Corp + admin<->customer toggle account; gate demo seed
- `4cd5567` feat(retention): purge resolved incidents/problems/changes after 30 days

**Push 41** — 2026-06-12 19:44:01 UTC → `feat/nexus-platform` (`4cd5567`..`21d2cf1`, 4 commits)
- `add6a5a` fix(authz): make platform-superuser cross-org consistent across PDP and RLS
- `68cfb1b` feat(content): expand service catalog (+13 items) and knowledge base (5 spaces, ~25 articles)
- `1d1d265` feat(catalog): add Request new software, Report broken hardware, Request new hardware
- `21d2cf1` feat(admin): platform admin UI for customers/users + catalog items (offboard, security/outage)

**Push 42** — 2026-06-12 19:51:04 UTC → `feat/nexus-platform` (`21d2cf1`..`06f235a`, 2 commits)
- `08dcda0` docs: catalog custom request forms design spec
- `06f235a` feat(portal): featured-services showcase using DisplayCards (offboard/security/outage)

**Push 43** — 2026-06-12 19:56:28 UTC → `feat/nexus-platform` (`06f235a`..`4e1ab34`, 3 commits)
- `0b9ab27` fix(portal): make 'Search common requests' actually search the knowledge base
- `b940aae` docs: catalog request forms implementation plan (3 tiers)
- `4e1ab34` feat(forms): migration — catalog form link, people/attachment field types, seed new-user form

**Push 44** — 2026-06-12 19:58:14 UTC → `feat/nexus-platform` (`4e1ab34`..`2a821f2`, 1 commit)
- `2a821f2` feat(api): force option on org delete to remove an org's users too

**Push 45** — 2026-06-12 20:32:12 UTC → `feat/nexus-platform` (`2a821f2`..`c755226`, 7 commits)
- `e1079ec` feat(forms): GET /catalog/:key/form endpoint
- `3775c9e` feat(forms): GET /users/search for people pickers (org-scoped)
- `5ce0bd3` feat(forms): mapFormAnswers — route answers to ticket/approvals/custom_fields
- `3af1e91` feat(forms): route form answers in createRequest (requester, custom_fields, approval steps)
- `f63ee9b` feat(web): api client — catalog.form, users.search, attachment upload
- `7e7483e` feat(web): UserPicker people-picker component
- `c755226` feat(web): dynamic request form in catalog modal (pickers, system, attachment)

**Push 46** — 2026-06-12 23:15:05 UTC → `feat/nexus-platform` (`c755226`..`3b01614`, 10 commits)
- `6eb6a79` docs: Phase 2 hardening design spec (live widgets, create UIs, integration tests)
- `6a271ad` docs: Phase 2 hardening implementation plan (tests, widgets, create UIs)
- `f66c787` test(phase2): integration tests for services/channels/dashboards/alerts
- `67eae81` fix(dashboards): seed default dashboard per org in seed.ts (migration ran before orgs existed)
- `4d332de` feat(dashboards): render widgets with live data (KPIs, posture, volume, findings, recent tickets)
- `cf94585` feat(channels): New channel create modal
- `c0fb5cd` feat(dashboards): New dashboard create modal (name + widget picker)
- `80f97af` fix(dashboards): guard create-reload with catch; stabilize widget keys
- `89bf1f5` test(services): assert ticket_count is a number, not just present
- `3b01614` feat(forms): request forms for group/guest/PIM/keyvault/identity-center/license items

**Push 47** — 2026-06-12 23:15:56 UTC → `feat/nexus-platform` (`3b01614`..`e0afad7`, 1 commit)
- `e0afad7` ops(deploy): repeatable web deploy script + fix CI packaging for standalone

**Push 48** — 2026-06-12 23:24:40 UTC → `feat/nexus-platform` (`e0afad7`..`b406f0c`, 1 commit)
- `b406f0c` feat(forms): offboarding form (affected-user mapping; requester = submitter)

**Push 49** — 2026-06-12 23:25:12 UTC → `feat/nexus-platform` (`b406f0c`..`bdd4454`, 1 commit)
- `bdd4454` ops(deploy): fix Azure web-deploy trigger to match the OIDC credential branch

**Push 50** — 2026-06-13 01:07:43 UTC → `feat/nexus-platform` (`bdd4454`..`47b866c`, 6 commits)
- `252fc6d` fix(web): isolate deploy build into NEXT_DIST_DIR so it never clobbers dev .next
- `c497d0e` docs: competitive gap analysis + enterprise roadmap
- `2c181f0` docs: escalation policies implementation plan
- `a99d80a` feat(authz): escalation.read/manage permissions
- `e90e7a2` feat(db): 0035 escalation_policies table with RLS
- `47b866c` feat(web): ticket attachments UI (upload/list/download) for customers and agents

**Push 51** — 2026-06-13 01:13:54 UTC → `feat/nexus-platform` (`47b866c`..`876d86c`, 4 commits)
- `848558f` feat(escalation): pure step logic + CRUD module (TDD)
- `7adf774` feat(escalation): routes, client helpers, /escalation-policies page, nav entry
- `3b33955` feat(escalation): integration test; fix user lookup via withSystemContext (nexus-plane RLS)
- `876d86c` feat(catalog): structured intake forms for M365 offboard + security/outage/phishing

**Push 52** — 2026-06-13 01:52:49 UTC → `feat/nexus-platform` (`876d86c`..`69d0bbd`, 1 commit)
- `69d0bbd` feat(catalog): comprehensive onboarding intake + forms for remaining catalog items

**Push 53** — 2026-06-13 11:25:37 UTC → `feat/nexus-platform` (`69d0bbd`..`ef0cf0d`, 1 commit)
- `ef0cf0d` fix(api/web): empty-body DELETE returned 500; add force-delete for populated orgs

**Push 54** — 2026-06-13 11:30:30 UTC → `feat/nexus-platform` (`ef0cf0d`..`b939829`, 1 commit)
- `b939829` fix(api): strip application/json content-type on empty-body requests (onRequest hook)

**Push 55** — 2026-06-13 11:47:16 UTC → `feat/nexus-platform` (`b939829`..`1f12f20`, 1 commit)
- `1f12f20` feat(demo): working demo toggle account (agent <-> customer) for gov

**Push 56** — 2026-06-25 19:02:19 UTC → `feat/nexus-platform` (`1f12f20`..`92df47f`, 44 commits)
- `c94fa32` feat(oncall): delete schedules, remove responders, cell numbers + sample escalation policies
- `1710b6b` feat(kb,web): M365/AWS/Azure + self-help KB articles; light/dark mode
- `3021d50` fix(kb): render inline **bold**, `code`, links, and fenced code blocks
- `a806782` fix(mail): emailed tickets now generate no-reply notifications
- `e2f0f9f` feat(mail): prime delta cursor on first ingest run (skip existing inbox)
- `cecf73c` feat(mail): rich customer acknowledgment (name, ticket id, summary, time, priority)
- `e0b837c` feat(mail): customer notifications for agent reply, resolution, and CSAT
- `0e648d0` feat(mail): Tier-2 customer notifications — assigned, closed, reopened, approvals
- `7446949` feat(mail): mark GCC High email channel supported (capability gate)
- `9faaf32` chore(web): install official Anthropic frontend-design skill; remove Pricing & Docs nav links
- `957708e` feat(web): cohesive type system — Public Sans + JetBrains Mono (self-hosted)
- `99be606` fix(csat): make 'rate your experience' work for any resolved ticket
- `e03e03d` fix(mail): notify requester + support team on new ticket (all channels)
- `14834cf` fix(sla): mark response SLA met on first response (was always breaching)
- `7b60c24` feat(dashboards): enterprise KPI/SLA/operations dashboards
- `5ea4fda` feat(dashboards): add Team, Customer portfolio, Posture & compliance, On-call & change
- `63c9124` feat(mail): thread inbound email replies onto the existing ticket
- `173fe16` feat(ops): notification delivery-health dashboard + codified API deploy
- `85e80c6` feat(reliability): notification send-retry + in-boundary migrate-on-boot
- `0d3d167` feat(brand): new Anchor logo + favicon across the app
- `37020a0` chore(web): remove 'Get started' hero CTA on the landing page
- `020ccc1` chore(web): remove 'Get started' signup button from the landing nav
- `56f135b` feat(web): add full Anchor lockup (mark + ITSM Platform tagline) to landing hero
- `6f5561b` style(web): enlarge landing hero lockup, reduce headline size for balance
- `85cc8eb` feat(brand): use exact Anchor logo pack assets + refine landing hero
- `5a89345` feat(web): Gov-cloud-only landing — drop headline + all 'Commercial' copy
- `7490ad6` fix(brand): transparent mark (knock out white bg) + remove hero eyebrow/headline
- `657d5ab` feat(web): minimal logo-only landing hero (remove subtitle)
- `171793f` chore(web): drop 'Commercial' from site metadata description (Gov-cloud only)
- `46dfd75` docs: release newsletter + mgmt brief, ServiceNow parity plan, HelpDesk guides
- `ef2eb34` feat(web): stacked, larger, centered landing logo
- `ce36fa4` feat(catalog): User Device Intune Enrollment item + portal search deep-link
- `0879020` feat: platform user administration (ServiceNow parity Phase 1)
- `aff318f` feat(web): change calendar month view (Phase 2)
- `e7a4dde` feat(cmdb): CI attributes, ownership & relationships (Phase 2)
- `eb3e39d` feat: flow designer, report builder & virtual agent (Phases 3-4)
- `f4486b6` feat(kb): add global Help Desk self-service articles
- `769f145` docs: update NexusCyber Hotline number to (800) 265-6446
- `fa5aff4` feat(web): site-entry welcome dialog + rolling hotline banner
- `297a60a` fix(kb): audit fixes — dedupe, security URLs/contact, tag hygiene, gap-fill
- `23bfecd` feat(web): add CUI/sensitive-data warning to rolling banner
- `ae706af` feat(kb): article 'did this resolve your issue?' deflection + deep-linking
- `1cfc987` fix(web): show welcome dialog once per login for every user
- `92df47f` docs: Anchor change-log newsletter (June 25, 2026)

**Push 57** — 2026-06-25 19:06:14 UTC → `feat/nexus-platform` (`92df47f`..`e1dd763`, 1 commit)
- `e1dd763` docs: next-level platform review + 'how to create a ticket' walkthrough

**Push 58** — 2026-06-25 19:14:20 UTC → `feat/nexus-platform` (`e1dd763`..`f2e75cf`, 1 commit)
- `f2e75cf` feat(web): serve ticket walkthrough in-app + skippable portal prompt

**Push 59** — 2026-06-25 20:59:01 UTC → `feat/nexus-platform` (`f2e75cf`..`9221cc7`, 5 commits)
- `55bfbbd` docs: design spec — CMDB self-population via per-customer Entra/Intune device sync
- `05daa95` docs: implementation plan — CMDB Entra/Intune device sync
- `be791ed` fix(kb): close 7 editorial gaps in help-center articles
- `2f5c55c` feat(sla): align severity SLA matrix to published 8x5 service levels
- `9221cc7` docs: Anchor exec briefing deck, feature one-pager (+PDF) and intro email

**Push 60** — 2026-06-26 00:55:51 UTC → `feat/nexus-platform` (`9221cc7`..`26377c9`, 1 commit)
- `26377c9` feat(web): premium customer-facing homepage + app-wide aesthetic pass

**Push 61** — 2026-06-26 01:15:40 UTC → `feat/nexus-platform` (`26377c9`..`60b1404`, 1 commit)
- `60b1404` fix(web): enlarge landing/footer typography + replace fabricated hero stats

**Push 62** — 2026-06-26 01:25:52 UTC → `feat/nexus-platform` (`60b1404`..`3324894`, 1 commit)
- `3324894` style(web): nudge landing typography up one more step

**Push 63** — 2026-06-26 02:34:44 UTC → `feat/nexus-platform` (`3324894`..`0f056f7`, 1 commit)
- `0f056f7` chore(security): upgrade Next.js 14.2.35 -> 15.5.19; bump CI actions

**Push 64** — 2026-06-26 02:48:53 UTC → `feat/nexus-platform` (`0f056f7`..`7407f76`, 1 commit)
- `7407f76` fix(web): add customer selector to posture & compliance (fix blank pages)

**Push 65** — 2026-06-26 02:58:21 UTC → `feat/nexus-platform` (`7407f76`..`2480c60`, 1 commit)
- `2480c60` feat(billing): admin-only per-customer utilization & overage billing portal

**Push 66** — 2026-06-26 03:12:14 UTC → `feat/nexus-platform` (`2480c60`..`b1bc9aa`, 1 commit)
- `b1bc9aa` chore(security): migrate API fastify 4 -> 5 (clears fast-uri HIGH)

**Push 67** — 2026-06-26 03:15:32 UTC → `feat/nexus-platform` (`b1bc9aa`..`08e76d5`, 1 commit)
- `08e76d5` feat(intune): Anchor IT Support shortcut + Intune deployment package

**Push 68** — 2026-06-26 03:46:16 UTC → `feat/nexus-platform` (`08e76d5`..`5797671`, 5 commits)
- `5c09127` docs: design spec — enterprise change management + CAB quorum voting
- `53fbb88` docs: implementation plan — enterprise change management + CAB voting
- `c6f9385` feat(changes): pure CAB voting resolver + risk derivation
- `ba8f7ad` feat(db): CAB voting subsystem schema + permissions (0052)
- `5797671` feat(integration): Anchor two-way sync — M2M API keys, idempotent ticket upsert, outbound webhooks

**Push 69** — 2026-06-26 03:56:58 UTC → `feat/nexus-platform` (`5797671`..`6c81404`, 2 commits)
- `7dda20e` feat(changes): CAB board administration module
- `6c81404` chore(web): refresh generated next-env.d.ts + tsbuildinfo

**Push 70** — 2026-09-02 12:50:13 UTC → `feat/nexus-platform` (`6c81404`..`c9878e3`, 56 commits)
- `03648fe` fix(deps): clear prod-reachable security advisories
- `c2b4dd5` docs: design spec — SBS new-user onboarding + Entra/Cloud PC provisioning
- `e6190ff` docs: implementation plan — SBS onboarding + Entra/Cloud PC provisioning
- `07c463b` feat(forms): email/phone field types + visible_when, sensitive, options_source columns
- `adb0c1a` fix(forms): require at least one digit in phone validator
- `5c2a624` feat(forms): conditional field visibility via visible_when
- `4c4347c` feat(pii): sensitive-field storage with pii.view permission and audited reads
- `390e035` feat(pii): route sensitive answers out of custom_fields; add audited read endpoint
- `951359a` feat(pii): purge sensitive onboarding fields once the ticket closes
- `b6d06a3` feat(forms): seed SBS new-user onboarding fields with conditional and sensitive flags
- `64664e4` fix(forms): delete superseded manager field on user_onboarding
- `1a85af4` feat(web): extract DynamicFormField with conditional visibility and email/phone types
- `21de7bb` fix(pii): enforce the sensitive-field guarantee on the catalog intake path
- `8209c95` feat(graph): add PATCH verb and selectable API version
- `61ed1fa` feat(provisioning): configuration parsed from M365_PROV_* env
- `ed40cd7` feat(provisioning): Graph adapter for users, licenses, groups, TAP, Cloud PC
- `08f4870` feat(provisioning): pure planner with UPN derivation, SKU resolution, and blockers
- `2aaf8f7` fix(provisioning): planner isolation + empty-local-part UPN guard
- `24ec172` feat(db): provisioning runs and steps with provisioning.execute permission
- `07733a4` fix(db): add organization_id and RLS to provisioning_steps table
- `b2d0daf` feat(provisioning): idempotent step executor with adoption and delta licensing
- `722677f` fix(provisioning): redact secrets from step errors, guard userId, validate group ids
- `13d7132` feat(provisioning): Cloud PC poller with deadline handling
- `d176e34` fix(provisioning): make Cloud PC Graph API version configurable
- `c1cd870` feat(provisioning): preview/execute service and HTTP routes
- `db04c3d` fix(provisioning): in-flight guard covers awaiting_cloudpc; pin the safety invariants
- `c1ca63b` feat(db): 0057 — at most one in-flight provisioning run per ticket
- `0fafa0c` feat(web): provisioning panel with dry-run preview and blocker gating
- `9205029` fix(web): unwrap the {data} envelope in the provisioning panel; a11y for blocker reason
- `7bedd0e` fix(retention): guard PII destruction tombstones per record
- `d2548e9` fix(provisioning): bind execute to the approved preview, close the fail-open paths
- `0b3d62a` fix(provisioning): scope the supervisor lookup by org only, not by plane
- `61eeb93` fix(db): explicit GRANTs for ticket_sensitive_fields + provisioning tables
- `140b93a` fix(tickets): block PII-shaped keys in M2M-supplied custom_fields
- `31dc956` test(api): prove supervisor org-scoping predicate against real Postgres
- `8262490` test(web): add Vitest runner, pin form-visibility to shared fixtures, guard provisioning envelope unwrap
- `7b063bc` feat(changes): quorum voting, comments, cancel, PIR endpoints
- `37e0a83` fix(cab): gate global CAB rows, serialize votes, enforce SoD
- `184b297` feat(cab): persist the requested quorum so a clamped vote stays visible
- `8c1ea6a` refactor(changes): extract ChangeCalendar + ChangeList, add a typed changes client
- `348268d` feat(changes): CAB vote panel — tally, quorum, recusal, ballots
- `d8ddc5e` feat(changes): ChangeDetail — plans, risk provenance, deliberation, PIR, cancel
- `e93c076` feat(cab): CAB administration UI — board, blackouts, templates
- `6dd6274` feat(changes): list \| calendar \| CAB settings tabs
- `1ad3ef7` fix(changes): do not leave the vote panel disabled when the refetch fails
- `4c720ec` fix(cab): stop the board editor from silently resetting member vote weights
- `f7ba75e` fix(cab): the board can no longer be bypassed or packed by the raiser
- `95a37b0` fix(cab): the CRITICAL-1 fix now holds on legacy data
- `8b20af0` docs: tenant probe script, CAB deployment runbook, app-registration guide
- `8f57dd5` feat(changes): CAB notifications + deadline escalation sweeper
- `b9faefa` fix(changes): CAB notifications fix round 1 — tenant-scope test rigor + sweeper hardening
- `35f4f73` fix(provisioning): normalize SKU/policy/group matching against invisible tenant chars
- `f32b44d` fix(web): stop the changes page tests exiting non-zero on a bad mock
- `708b7ff` fix(tickets): serialize ticket-number allocation on all three create paths
- `e3d918e` fix(tickets): commit dedupe marker atomically with ingest ticket, harden rollback
- `c9878e3` docs(readme): cover provisioning, CAB voting, and the web test suite

**Push 71** — 2026-09-02 13:04:44 UTC → `feat/nexus-platform` (`c9878e3`..`bcbc1b7`, 1 commit)
- `bcbc1b7` docs(readme): spell out both dev-database invocation traps

**Push 72** — 2026-09-02 18:21:36 UTC → `feat/nexus-platform` (`bcbc1b7`..`b1627f1`, 2 commits)
- `1d5c002` fix(notifications): make the new-ticket desk email carry the real record
- `b1627f1` feat(provisioning): say when the feature is off instead of offering a dead button

**Push 73** — 2026-09-02 20:07:10 UTC → `feat/nexus-platform` (`b1627f1`..`511a3d6`, 2 commits)
- `81ba070` docs(offboarding): design for the SBS offboarding engine (phase 1)
- `511a3d6` fix(ingest): make a mail-driven reopen legal, visible, and clean

**Push 74** — 2026-09-02 20:10:56 UTC → `feat/nexus-platform` (`511a3d6`..`aa6b2c0`, 1 commit)
- `aa6b2c0` fix(seed): link catalog items to their request forms

**Push 75** — 2026-09-02 20:21:55 UTC → `feat/nexus-platform` (`aa6b2c0`..`bb8366f`, 2 commits)
- `b9c51ea` docs(offboarding): resolve the two open questions in the phase-1 design
- `bb8366f` docs(offboarding): implementation plan for phase 1

**Push 76** — 2026-09-02 21:03:02 UTC → `feat/nexus-platform` (`bb8366f`..`e3b7a99`, 13 commits)
- `2b417d4` feat(offboarding): widen provisioning runs for offboarding kind and scheduling
- `fb273c1` feat(offboarding): the ZZ_Inactive rename convention as a pure function
- `b204591` feat(offboarding): planner with fixed step order and refusal blockers
- `fcb469e` feat(offboarding): fingerprint binding an approved plan to its exact writes
- `c9717e8` feat(offboarding): Graph operations for disable, revoke, rename, delicense, degroup
- `bdce86a` feat(offboarding): executor halting at the manual mailbox step
- `53ef022` feat(offboarding): service layer with one planning path and scheduling
- `73e5f67` feat(offboarding): scheduled sweeper that still disables on plan drift
- `1307663` feat(offboarding): intake captures a disable instant, not a bare date
- `f856c61` feat(offboarding): ticket panel for preview and scheduling
- `790c93b` fix(offboarding): gate offboarding separately from onboarding
- `2f7a52f` docs(offboarding): record the two-gate correction in the spec and plan
- `e3b7a99` Merge offboarding phase 1: M365 teardown behind a scheduled, approved plan

**Push 77** — 2026-09-02 21:20:31 UTC → `feat/nexus-platform` (`e3b7a99`..`6ed73c7`, 1 commit)
- `6ed73c7` fix(tickets): clear terminal stamps on reopen, repair whitespace in ticket numbers

**Push 78** — 2026-09-02 22:13:34 UTC → `feat/nexus-platform` (`6ed73c7`..`60a6f06`, 1 commit)
- `60a6f06` feat(catalog): dual-write the catalog->form links, with an invariant test

**Push 79** — 2026-09-02 23:35:15 UTC → `feat/nexus-platform` (`60a6f06`..`ab739d7`, 4 commits)
- `8c9527e` fix(offboarding): resolve the departing account from the ticket, not from form text
- `f6141fc` fix(offboarding): gate preview and schedule on the request, not just the permission
- `75c3df3` fix(offboarding): make the drift inversion actually hold
- `ab739d7` fix(offboarding): stranded runs, duplicate arming, and unpaginated memberships

**Push 80** — 2026-09-02 23:55:23 UTC → `feat/nexus-platform` (`ab739d7`..`d94e39f`, 1 commit)
- `d94e39f` feat(offboarding): let an armed run be cancelled

**Push 81** — 2026-09-03 00:18:41 UTC → `feat/nexus-platform` (`d94e39f`..`ca91f54`, 2 commits)
- `f11835c` docs(offboarding): design for phase 2 retention holds
- `ca91f54` docs(retention): implementation plan for offboarding phase 2

**Push 82** — 2026-09-03 00:27:14 UTC → `feat/nexus-platform` (`ca91f54`..`37d64ec`, 6 commits)
- `735f61a` feat(retention): retention_holds table and the review catalog item
- `6145e1c` feat(retention): classification on any evidence of privilege ever, and the clock
- `98e4398` feat(retention): record a hold when an offboarding run succeeds
- `c3f9fcf` feat(retention): the pure sweep decision, including the un-checkable case
- `ae91928` feat(retention): daily sweep that notices breaches and expiries
- `37d64ec` Merge offboarding phase 2: retention holds

**Push 83** — 2026-09-03 00:43:31 UTC → `feat/nexus-platform` (`37d64ec`..`c1f4fef`, 1 commit)
- `c1f4fef` feat(scripts): read-only probe for the tenant assumptions we have never verified

**Push 84** — 2026-09-03 00:46:43 UTC → `feat/nexus-platform` (`c1f4fef`..`bec9252`, 1 commit)
- `bec9252` docs(cmdb): drift-check the June device-sync plan and fix its migration numbers

**Push 85** — 2026-09-03 01:01:56 UTC → `feat/nexus-platform` (`bec9252`..`9d83376`, 3 commits)
- `0bcc996` fix(retention): the feature recorded no hold for the common departure
- `d50d5d2` fix(retention): sweep robustness and a breach ticket that reaches someone
- `9d83376` Merge retention-holds review fixes

**Push 86** — 2026-09-03 02:53:17 UTC → `feat/nexus-platform` (`9d83376`..`7b57f2d`, 2 commits)
- `0c6235f` fix(offboarding): defects introduced by the first round of review fixes
- `7b57f2d` Merge review fixes for the offboarding fixes (third review)

**Push 87** — 2026-09-03 02:53:39 UTC → `feat/nexus-platform` (`7b57f2d`..`f9df458`, 1 commit)
- `f9df458` chore: untrack apps/web/OneDeploy, committed by accident

**Push 88** — 2026-09-03 11:10:44 UTC → `feat/nexus-platform` (`f9df458`..`34be4be`, 2 commits)
- `07946a6` fix(deploy): verify the build that answers, not merely that something answers
- `34be4be` Merge deploy build-verification

**Push 89** — 2026-09-03 12:09:29 UTC → `feat/nexus-platform` (`34be4be`..`a64ac5a`, 2 commits)
- `bce4682` fix(auth): suspended users could still sign in and keep live sessions
- `a64ac5a` Merge: enforce account status in the auth path

**Push 90** — 2026-09-03 12:17:59 UTC → `feat/nexus-platform` (`a64ac5a`..`1af5461`, 2 commits)
- `8614cab` feat(scripts): stand down seeded demo identities, without deleting them
- `1af5461` Merge demo-identity stand-down

**Push 91** — 2026-09-03 12:47:31 UTC → `feat/nexus-platform` (`1af5461`..`29e1d10`, 1 commit)
- `29e1d10` ci(web): allow deploys from main alongside feat/nexus-platform

**Push 92** — 2026-09-03 12:48:45 UTC → `main` (`7508d74`..`13a7914`, 322 commits)
- `4d2ce49` docs: Tier 1 (security & compliance) implementation plan
- `11d601e` test: add skip-if-no-DB integration-test scaffolding
- `732c39e` feat(ui): vendored Footer + split-screen auth pages (FloatingPaths)
- `2536ddf` feat(compliance): control coverage, evidence export, posture exception SoD flow
- `15f4fe5` docs: M365 GCC integration design spec (notifications + ingestion)
- `31f8d8c` feat(audit): SIEM export (NDJSON/CEF) + hash-chain verification
- `5a1df7f` feat(elevation): JIT privilege elevation + break-glass; deterministic audit ordering
- `f9e1bee` docs: landing page redesign (simple & modern) design spec
- `76ba1a4` docs: M365 GCC integration implementation plan (4 tiers)
- `e948a67` feat(attachments): secure upload/scan/scoped-download + concurrency-safe audit chain
- `fefa59d` ci: Postgres service for integration tests + CodeQL, SBOM, dependency review; docs
- `390913c` fix(automation): write add_internal_note to ticket_comments (internal), not a nonexistent table
- `0bf0062` feat(m365): add M365 GCC config block + parser
- `e7344c5` feat(m365): client-credentials token provider with caching
- `a303dc0` feat(m365): Graph HTTP client with throttle/retry
- `4572dd6` feat(m365): notification adapter interface + console dev adapter
- `173e87d` feat(kb): Confluence-style knowledge base + canonical audit hashing
- `cd2ba18` feat(m365): migration for prefs, integration state, health, delivery columns
- `4060701` feat(m365): per-event notification templates
- `0ff7177` feat(tickets): linking + merge (JSM-style related issues)
- `569b5a2` feat(m365): resolve notification recipients from domain context
- `321dc94` feat(m365): Graph email + Teams adapter
- `bb9cd70` feat(changes): change management + CAB with multi-step approvals & calendar
- `338efd6` chore(brand): copyright punctuation — NexusCyber. A Strategic Business Systems Company.
- `c8efc4d` feat(m365): real dispatcher (recipients + render + send + record)
- `4e6e4bd` chore(brand): update copyright — operated as part of Strategic Business Systems, Inc.
- `8b3b259` feat(problems): ITIL problem management with known-error + incident clustering
- `41746fe` fix(m365): Teams posts once per dispatch; runtime retries on transient error; per-channel skipped records
- `1c13b20` feat(csat): satisfaction surveys on ticket resolution
- `43949b4` feat(m365): inbound mail ingestion (delta fetch + message->ticket)
- `4bf9f3e` feat(queues): saved agent work queues with SLA-aware sorting (JSM parity)
- `9c45a30` feat(m365): mail-ingest scheduler wired into server
- `08e3af9` feat(m365): integration health probes + test service
- `4fc286f` docs: Jira-parity feature build design spec
- `98140ca` feat(m365): health + test integration routes
- `926586a` feat(observability): Prometheus /metrics + README; finalize JSM/Confluence parity
- `561f064` docs(m365): README notes for GCC notifications + dev transport
- `505bbcc` fix(m365): HTML-escape user data in notification email/Teams bodies
- `48f39a9` docs: Jira-parity Phase 1 implementation plan (wire-ups)
- `9b1838b` feat(authz): add queue.read/service/org/notifications permissions + grants
- `fd1f9b4` feat(sla): pause/resume + holiday calendars (Tier-2 WP6)
- `6b95dce` feat(cmdb): services + configuration-items API, client, and /services page
- `220266c` feat(worklogs): ticket time tracking (JSM parity)
- `5d50624` feat(automation): gated-action approvals (Tier-2 WP8)
- `d4647b1` feat(canned): reusable canned responses with placeholder rendering (JSM parity)
- `3f6a71c` fix(cmdb): validate service POST bodies, align kind default, label criticality
- `98b007a` fix(m365): resolve specific responder for oncall notifications
- `67b1dbf` feat(tickets): bulk actions (JSM parity)
- `248daaf` feat(customers): org detail/update/users API, client, and /customers page
- `9ccc3da` feat(tickets): participants/watchers + @mentions (JSM A10)
- `7367111` feat(ops): runbook scripts (smoke, db backup/restore) + REST API collection
- `3235a46` feat(workflows): configurable ticket status workflows (JSM A7)
- `2840ae7` fix(tickets): serialize ticket-number allocation under concurrency
- `1f7a515` fix(customers): enum-validate cloud, return safe org columns, surface detail load errors
- `e0162ec` feat(notifications): delivery log query API, client, and /email-logs page
- `fc2e674` fix(notifications): validate/clamp deliveries query limit (prevent LIMIT -1 bypass)
- `b7fbf6b` feat(incidents): /incidents view (tickets filtered to type=incident)
- `8001f80` feat(nav): surface incidents, services, customers, email-logs in agent nav
- `8ada8be` fix(phase1): wire ticket type filter, authorize service reads, allow org.read to list orgs
- `761c646` ci(docker): build, smoke-test, and publish container images to GHCR
- `4605150` feat(forms): custom request forms & field validation (JSM A4)
- `d7e5cba` docs: Jira-parity Phase 2 implementation plan (alerts, channels, dashboards)
- `a83cc37` feat(authz): add alert/channel/dashboard permissions + grants
- `6d1e0de` feat(alerts): alerts table + RLS + open-alert dedup index
- `3481d2b` feat(alerts): alert state-machine + tests
- `f5027a4` feat(announcements): portal announcements + idempotency fixes
- `9a2d8cf` feat(alerts): ingest/ack/resolve/escalate API, client, and /alerts feed
- `47620ec` fix(alerts): explicit column lists (drop SELECT */RETURNING *)
- `3fff542` feat(channels): channels table + RLS
- `aad157f` feat(channels): channel CRUD API, client, and /channels page
- `54f447c` feat(dashboards): dashboards table + RLS + seeded default per org
- `409da71` feat(dashboards): named dashboards CRUD + widget catalog API, client, and /dashboards page
- `f0eb02e` feat(nav): surface alerts, channels, dashboards in agent nav
- `f4afaf0` docs: Jira-parity Phase 3 implementation plan (IA/nav)
- `206a3e4` feat(get-started): in-app quick-start surface
- `9722a8b` feat(archived): closed/archived work items view
- `dbcc3a6` feat(nav): group agent sidebar into Work/Operations/Insights/Security sections; add Get started + Archived
- `009766d` fix(nav): allow the longer sectioned sidebar to scroll (overflow-y-auto)
- `c4650ea` fix(authz): grant ticket.create to ServiceDeskManager so alert escalation can open a ticket
- `987be77` feat(deploy): Azure Government App Service (Web Apps for Containers) deployment
- `43fd01d` fix(db): resolve admin-pool deadlock in auth path (blank catalog/hung requests)
- `b5b7100` feat(catalog): add M365/Azure/AWS gov-cloud service catalog items
- `d05ffbe` feat(deploy): support Azure App Service "Code" (Node 20-LTS) deploy + workflow
- `6764769` ci(deploy): build apps/web in CI for Azure Code deploy (reliable on F1)
- `c2e2a5d` ci(deploy): drop GitHub Environment gate from web deploy workflow
- `bf2c3eb` ci(deploy): use Entra OIDC for web deploy (gov disables basic auth)
- `5d7c280` infra(azure-gov): add API-only bicep for Anchor backend (KV-free, gov-policy-compliant)
- `07583cc` docs(auth): scope Entra ID (Azure Gov) OIDC for the agent plane
- `ac42aa6` feat(auth): Entra ID (Azure Gov) OIDC for the agent plane (Phase 1, disabled by default)
- `6921aa6` docs(auth): add customer multi-tenant Entra OIDC plan + config guide
- `7a4e5b4` feat(auth): Phase 2 — multitenant customer Entra OIDC (disabled by default)
- `1609fb3` feat(api): admin create-org endpoint to onboard customer tenants for SSO
- `0365822` fix(auth): surface the rejected tenant id in the customer-SSO not-onboarded error
- `63e5a5b` feat(api): admin DELETE /organizations/:id (refuses if org has users)
- `5e5dd29` feat(web): Microsoft logo on the two SSO buttons (agent + customer)
- `c582749` feat(web): rename agent SSO button to "Sign in as Anchor staff"; drop signup link
- `ee5d565` feat(web): real Terms of Service and Privacy Policy pages
- `4011774` fix(api): make admin org-delete clear non-cascade child rows first
- `268c3f5` feat(notifications): make email a supported channel for GCC
- `9f14f76` feat(auth): SuperAdmin role + platform-admin bootstrap; superuser is cross-org; rename SSO button to "Sign in as Admin"
- `51b628c` feat(notifications): event-aware recipient routing (agents on new ticket, customer on updates)
- `37bc980` feat(notifications): new tickets notify a shared desk mailbox, not every agent
- `dd1a318` feat(demo): single Demo Corp + admin<->customer toggle account; gate demo seed
- `4cd5567` feat(retention): purge resolved incidents/problems/changes after 30 days
- `add6a5a` fix(authz): make platform-superuser cross-org consistent across PDP and RLS
- `68cfb1b` feat(content): expand service catalog (+13 items) and knowledge base (5 spaces, ~25 articles)
- `1d1d265` feat(catalog): add Request new software, Report broken hardware, Request new hardware
- `21d2cf1` feat(admin): platform admin UI for customers/users + catalog items (offboard, security/outage)
- `08dcda0` docs: catalog custom request forms design spec
- `06f235a` feat(portal): featured-services showcase using DisplayCards (offboard/security/outage)
- `0b9ab27` fix(portal): make 'Search common requests' actually search the knowledge base
- `b940aae` docs: catalog request forms implementation plan (3 tiers)
- `4e1ab34` feat(forms): migration — catalog form link, people/attachment field types, seed new-user form
- `2a821f2` feat(api): force option on org delete to remove an org's users too
- `e1079ec` feat(forms): GET /catalog/:key/form endpoint
- `3775c9e` feat(forms): GET /users/search for people pickers (org-scoped)
- `5ce0bd3` feat(forms): mapFormAnswers — route answers to ticket/approvals/custom_fields
- `3af1e91` feat(forms): route form answers in createRequest (requester, custom_fields, approval steps)
- `f63ee9b` feat(web): api client — catalog.form, users.search, attachment upload
- `7e7483e` feat(web): UserPicker people-picker component
- `c755226` feat(web): dynamic request form in catalog modal (pickers, system, attachment)
- `6eb6a79` docs: Phase 2 hardening design spec (live widgets, create UIs, integration tests)
- `6a271ad` docs: Phase 2 hardening implementation plan (tests, widgets, create UIs)
- `f66c787` test(phase2): integration tests for services/channels/dashboards/alerts
- `67eae81` fix(dashboards): seed default dashboard per org in seed.ts (migration ran before orgs existed)
- `4d332de` feat(dashboards): render widgets with live data (KPIs, posture, volume, findings, recent tickets)
- `cf94585` feat(channels): New channel create modal
- `c0fb5cd` feat(dashboards): New dashboard create modal (name + widget picker)
- `80f97af` fix(dashboards): guard create-reload with catch; stabilize widget keys
- `89bf1f5` test(services): assert ticket_count is a number, not just present
- `3b01614` feat(forms): request forms for group/guest/PIM/keyvault/identity-center/license items
- `e0afad7` ops(deploy): repeatable web deploy script + fix CI packaging for standalone
- `b406f0c` feat(forms): offboarding form (affected-user mapping; requester = submitter)
- `bdd4454` ops(deploy): fix Azure web-deploy trigger to match the OIDC credential branch
- `252fc6d` fix(web): isolate deploy build into NEXT_DIST_DIR so it never clobbers dev .next
- `c497d0e` docs: competitive gap analysis + enterprise roadmap
- `2c181f0` docs: escalation policies implementation plan
- `a99d80a` feat(authz): escalation.read/manage permissions
- `e90e7a2` feat(db): 0035 escalation_policies table with RLS
- `47b866c` feat(web): ticket attachments UI (upload/list/download) for customers and agents
- `848558f` feat(escalation): pure step logic + CRUD module (TDD)
- `7adf774` feat(escalation): routes, client helpers, /escalation-policies page, nav entry
- `3b33955` feat(escalation): integration test; fix user lookup via withSystemContext (nexus-plane RLS)
- `876d86c` feat(catalog): structured intake forms for M365 offboard + security/outage/phishing
- `69d0bbd` feat(catalog): comprehensive onboarding intake + forms for remaining catalog items
- `ef0cf0d` fix(api/web): empty-body DELETE returned 500; add force-delete for populated orgs
- `b939829` fix(api): strip application/json content-type on empty-body requests (onRequest hook)
- `1f12f20` feat(demo): working demo toggle account (agent <-> customer) for gov
- `c94fa32` feat(oncall): delete schedules, remove responders, cell numbers + sample escalation policies
- `1710b6b` feat(kb,web): M365/AWS/Azure + self-help KB articles; light/dark mode
- `3021d50` fix(kb): render inline **bold**, `code`, links, and fenced code blocks
- `a806782` fix(mail): emailed tickets now generate no-reply notifications
- `e2f0f9f` feat(mail): prime delta cursor on first ingest run (skip existing inbox)
- `cecf73c` feat(mail): rich customer acknowledgment (name, ticket id, summary, time, priority)
- `e0b837c` feat(mail): customer notifications for agent reply, resolution, and CSAT
- `0e648d0` feat(mail): Tier-2 customer notifications — assigned, closed, reopened, approvals
- `7446949` feat(mail): mark GCC High email channel supported (capability gate)
- `9faaf32` chore(web): install official Anthropic frontend-design skill; remove Pricing & Docs nav links
- `957708e` feat(web): cohesive type system — Public Sans + JetBrains Mono (self-hosted)
- `99be606` fix(csat): make 'rate your experience' work for any resolved ticket
- `e03e03d` fix(mail): notify requester + support team on new ticket (all channels)
- `14834cf` fix(sla): mark response SLA met on first response (was always breaching)
- `7b60c24` feat(dashboards): enterprise KPI/SLA/operations dashboards
- `5ea4fda` feat(dashboards): add Team, Customer portfolio, Posture & compliance, On-call & change
- `63c9124` feat(mail): thread inbound email replies onto the existing ticket
- `173fe16` feat(ops): notification delivery-health dashboard + codified API deploy
- `85e80c6` feat(reliability): notification send-retry + in-boundary migrate-on-boot
- `0d3d167` feat(brand): new Anchor logo + favicon across the app
- `37020a0` chore(web): remove 'Get started' hero CTA on the landing page
- `020ccc1` chore(web): remove 'Get started' signup button from the landing nav
- `56f135b` feat(web): add full Anchor lockup (mark + ITSM Platform tagline) to landing hero
- `6f5561b` style(web): enlarge landing hero lockup, reduce headline size for balance
- `85cc8eb` feat(brand): use exact Anchor logo pack assets + refine landing hero
- `5a89345` feat(web): Gov-cloud-only landing — drop headline + all 'Commercial' copy
- `7490ad6` fix(brand): transparent mark (knock out white bg) + remove hero eyebrow/headline
- `657d5ab` feat(web): minimal logo-only landing hero (remove subtitle)
- `171793f` chore(web): drop 'Commercial' from site metadata description (Gov-cloud only)
- `46dfd75` docs: release newsletter + mgmt brief, ServiceNow parity plan, HelpDesk guides
- `ef2eb34` feat(web): stacked, larger, centered landing logo
- `ce36fa4` feat(catalog): User Device Intune Enrollment item + portal search deep-link
- `0879020` feat: platform user administration (ServiceNow parity Phase 1)
- `aff318f` feat(web): change calendar month view (Phase 2)
- `e7a4dde` feat(cmdb): CI attributes, ownership & relationships (Phase 2)
- `eb3e39d` feat: flow designer, report builder & virtual agent (Phases 3-4)
- `f4486b6` feat(kb): add global Help Desk self-service articles
- `769f145` docs: update NexusCyber Hotline number to (800) 265-6446
- `fa5aff4` feat(web): site-entry welcome dialog + rolling hotline banner
- `297a60a` fix(kb): audit fixes — dedupe, security URLs/contact, tag hygiene, gap-fill
- `23bfecd` feat(web): add CUI/sensitive-data warning to rolling banner
- `ae706af` feat(kb): article 'did this resolve your issue?' deflection + deep-linking
- `1cfc987` fix(web): show welcome dialog once per login for every user
- `92df47f` docs: Anchor change-log newsletter (June 25, 2026)
- `e1dd763` docs: next-level platform review + 'how to create a ticket' walkthrough
- `f2e75cf` feat(web): serve ticket walkthrough in-app + skippable portal prompt
- `55bfbbd` docs: design spec — CMDB self-population via per-customer Entra/Intune device sync
- `05daa95` docs: implementation plan — CMDB Entra/Intune device sync
- `be791ed` fix(kb): close 7 editorial gaps in help-center articles
- `2f5c55c` feat(sla): align severity SLA matrix to published 8x5 service levels
- `9221cc7` docs: Anchor exec briefing deck, feature one-pager (+PDF) and intro email
- `26377c9` feat(web): premium customer-facing homepage + app-wide aesthetic pass
- `60b1404` fix(web): enlarge landing/footer typography + replace fabricated hero stats
- `3324894` style(web): nudge landing typography up one more step
- `0f056f7` chore(security): upgrade Next.js 14.2.35 -> 15.5.19; bump CI actions
- `7407f76` fix(web): add customer selector to posture & compliance (fix blank pages)
- `2480c60` feat(billing): admin-only per-customer utilization & overage billing portal
- `b1bc9aa` chore(security): migrate API fastify 4 -> 5 (clears fast-uri HIGH)
- `08e76d5` feat(intune): Anchor IT Support shortcut + Intune deployment package
- `5c09127` docs: design spec — enterprise change management + CAB quorum voting
- `53fbb88` docs: implementation plan — enterprise change management + CAB voting
- `c6f9385` feat(changes): pure CAB voting resolver + risk derivation
- `ba8f7ad` feat(db): CAB voting subsystem schema + permissions (0052)
- `5797671` feat(integration): Anchor two-way sync — M2M API keys, idempotent ticket upsert, outbound webhooks
- `7dda20e` feat(changes): CAB board administration module
- `6c81404` chore(web): refresh generated next-env.d.ts + tsbuildinfo
- `03648fe` fix(deps): clear prod-reachable security advisories
- `c2b4dd5` docs: design spec — SBS new-user onboarding + Entra/Cloud PC provisioning
- `e6190ff` docs: implementation plan — SBS onboarding + Entra/Cloud PC provisioning
- `07c463b` feat(forms): email/phone field types + visible_when, sensitive, options_source columns
- `adb0c1a` fix(forms): require at least one digit in phone validator
- `5c2a624` feat(forms): conditional field visibility via visible_when
- `4c4347c` feat(pii): sensitive-field storage with pii.view permission and audited reads
- `390e035` feat(pii): route sensitive answers out of custom_fields; add audited read endpoint
- `951359a` feat(pii): purge sensitive onboarding fields once the ticket closes
- `b6d06a3` feat(forms): seed SBS new-user onboarding fields with conditional and sensitive flags
- `64664e4` fix(forms): delete superseded manager field on user_onboarding
- `1a85af4` feat(web): extract DynamicFormField with conditional visibility and email/phone types
- `21de7bb` fix(pii): enforce the sensitive-field guarantee on the catalog intake path
- `8209c95` feat(graph): add PATCH verb and selectable API version
- `61ed1fa` feat(provisioning): configuration parsed from M365_PROV_* env
- `ed40cd7` feat(provisioning): Graph adapter for users, licenses, groups, TAP, Cloud PC
- `08f4870` feat(provisioning): pure planner with UPN derivation, SKU resolution, and blockers
- `2aaf8f7` fix(provisioning): planner isolation + empty-local-part UPN guard
- `24ec172` feat(db): provisioning runs and steps with provisioning.execute permission
- `07733a4` fix(db): add organization_id and RLS to provisioning_steps table
- `b2d0daf` feat(provisioning): idempotent step executor with adoption and delta licensing
- `722677f` fix(provisioning): redact secrets from step errors, guard userId, validate group ids
- `13d7132` feat(provisioning): Cloud PC poller with deadline handling
- `d176e34` fix(provisioning): make Cloud PC Graph API version configurable
- `c1cd870` feat(provisioning): preview/execute service and HTTP routes
- `db04c3d` fix(provisioning): in-flight guard covers awaiting_cloudpc; pin the safety invariants
- `c1ca63b` feat(db): 0057 — at most one in-flight provisioning run per ticket
- `0fafa0c` feat(web): provisioning panel with dry-run preview and blocker gating
- `9205029` fix(web): unwrap the {data} envelope in the provisioning panel; a11y for blocker reason
- `7bedd0e` fix(retention): guard PII destruction tombstones per record
- `d2548e9` fix(provisioning): bind execute to the approved preview, close the fail-open paths
- `0b3d62a` fix(provisioning): scope the supervisor lookup by org only, not by plane
- `61eeb93` fix(db): explicit GRANTs for ticket_sensitive_fields + provisioning tables
- `140b93a` fix(tickets): block PII-shaped keys in M2M-supplied custom_fields
- `31dc956` test(api): prove supervisor org-scoping predicate against real Postgres
- `8262490` test(web): add Vitest runner, pin form-visibility to shared fixtures, guard provisioning envelope unwrap
- `7b063bc` feat(changes): quorum voting, comments, cancel, PIR endpoints
- `37e0a83` fix(cab): gate global CAB rows, serialize votes, enforce SoD
- `184b297` feat(cab): persist the requested quorum so a clamped vote stays visible
- `8c1ea6a` refactor(changes): extract ChangeCalendar + ChangeList, add a typed changes client
- `348268d` feat(changes): CAB vote panel — tally, quorum, recusal, ballots
- `d8ddc5e` feat(changes): ChangeDetail — plans, risk provenance, deliberation, PIR, cancel
- `e93c076` feat(cab): CAB administration UI — board, blackouts, templates
- `6dd6274` feat(changes): list \| calendar \| CAB settings tabs
- `1ad3ef7` fix(changes): do not leave the vote panel disabled when the refetch fails
- `4c720ec` fix(cab): stop the board editor from silently resetting member vote weights
- `f7ba75e` fix(cab): the board can no longer be bypassed or packed by the raiser
- `95a37b0` fix(cab): the CRITICAL-1 fix now holds on legacy data
- `8b20af0` docs: tenant probe script, CAB deployment runbook, app-registration guide
- `8f57dd5` feat(changes): CAB notifications + deadline escalation sweeper
- `b9faefa` fix(changes): CAB notifications fix round 1 — tenant-scope test rigor + sweeper hardening
- `35f4f73` fix(provisioning): normalize SKU/policy/group matching against invisible tenant chars
- `f32b44d` fix(web): stop the changes page tests exiting non-zero on a bad mock
- `708b7ff` fix(tickets): serialize ticket-number allocation on all three create paths
- `e3d918e` fix(tickets): commit dedupe marker atomically with ingest ticket, harden rollback
- `c9878e3` docs(readme): cover provisioning, CAB voting, and the web test suite
- `bcbc1b7` docs(readme): spell out both dev-database invocation traps
- `1d5c002` fix(notifications): make the new-ticket desk email carry the real record
- `b1627f1` feat(provisioning): say when the feature is off instead of offering a dead button
- `81ba070` docs(offboarding): design for the SBS offboarding engine (phase 1)
- `511a3d6` fix(ingest): make a mail-driven reopen legal, visible, and clean
- `aa6b2c0` fix(seed): link catalog items to their request forms
- `b9c51ea` docs(offboarding): resolve the two open questions in the phase-1 design
- `bb8366f` docs(offboarding): implementation plan for phase 1
- `2b417d4` feat(offboarding): widen provisioning runs for offboarding kind and scheduling
- `fb273c1` feat(offboarding): the ZZ_Inactive rename convention as a pure function
- `b204591` feat(offboarding): planner with fixed step order and refusal blockers
- `fcb469e` feat(offboarding): fingerprint binding an approved plan to its exact writes
- `c9717e8` feat(offboarding): Graph operations for disable, revoke, rename, delicense, degroup
- `bdce86a` feat(offboarding): executor halting at the manual mailbox step
- `53ef022` feat(offboarding): service layer with one planning path and scheduling
- `73e5f67` feat(offboarding): scheduled sweeper that still disables on plan drift
- `1307663` feat(offboarding): intake captures a disable instant, not a bare date
- `f856c61` feat(offboarding): ticket panel for preview and scheduling
- `790c93b` fix(offboarding): gate offboarding separately from onboarding
- `2f7a52f` docs(offboarding): record the two-gate correction in the spec and plan
- `e3b7a99` Merge offboarding phase 1: M365 teardown behind a scheduled, approved plan
- `6ed73c7` fix(tickets): clear terminal stamps on reopen, repair whitespace in ticket numbers
- `60a6f06` feat(catalog): dual-write the catalog->form links, with an invariant test
- `8c9527e` fix(offboarding): resolve the departing account from the ticket, not from form text
- `f6141fc` fix(offboarding): gate preview and schedule on the request, not just the permission
- `75c3df3` fix(offboarding): make the drift inversion actually hold
- `ab739d7` fix(offboarding): stranded runs, duplicate arming, and unpaginated memberships
- `d94e39f` feat(offboarding): let an armed run be cancelled
- `f11835c` docs(offboarding): design for phase 2 retention holds
- `ca91f54` docs(retention): implementation plan for offboarding phase 2
- `735f61a` feat(retention): retention_holds table and the review catalog item
- `6145e1c` feat(retention): classification on any evidence of privilege ever, and the clock
- `98e4398` feat(retention): record a hold when an offboarding run succeeds
- `c3f9fcf` feat(retention): the pure sweep decision, including the un-checkable case
- `ae91928` feat(retention): daily sweep that notices breaches and expiries
- `37d64ec` Merge offboarding phase 2: retention holds
- `c1f4fef` feat(scripts): read-only probe for the tenant assumptions we have never verified
- `bec9252` docs(cmdb): drift-check the June device-sync plan and fix its migration numbers
- `0bcc996` fix(retention): the feature recorded no hold for the common departure
- `d50d5d2` fix(retention): sweep robustness and a breach ticket that reaches someone
- `9d83376` Merge retention-holds review fixes
- `0c6235f` fix(offboarding): defects introduced by the first round of review fixes
- `7b57f2d` Merge review fixes for the offboarding fixes (third review)
- `f9df458` chore: untrack apps/web/OneDeploy, committed by accident
- `07946a6` fix(deploy): verify the build that answers, not merely that something answers
- `34be4be` Merge deploy build-verification
- `bce4682` fix(auth): suspended users could still sign in and keep live sessions
- `a64ac5a` Merge: enforce account status in the auth path
- `8614cab` feat(scripts): stand down seeded demo identities, without deleting them
- `1af5461` Merge demo-identity stand-down
- `29e1d10` ci(web): allow deploys from main alongside feat/nexus-platform
- `13a7914` Merge feat/nexus-platform into main

**Push 93** — 2026-09-03 12:51:20 UTC → `main` (`13a7914`..`2540aa5`, 1 commit)
- `2540aa5` ci(web): deploy from main only, retiring the transition

**Push 94** — 2026-09-03 15:07:47 UTC → `main` (`2540aa5`..`1b71889`, 15 commits)
- `90d524f` feat(db): org_integrations, sync-run history, CI provenance columns
- `f98fd87` feat(authz,config): integration.credentials.manage and Entra sync settings
- `907f496` feat(entra): envelope encryption and the device->CI mapper
- `d0f96c8` feat(entra): per-org Graph client factory and managedDevices enumeration
- `d0e061f` feat(entra): device sync orchestrator with retire-on-complete and run logging
- `5a2c9e8` feat(entra): admin module — configure, status, test, enable, trigger
- `4ef1caa` feat(entra): admin + sync routes and the scheduled per-org sync job
- `60d1333` feat(web): Entra device-sync integration admin page
- `9bc2a29` fix(entra): ON CONFLICT must repeat the partial index predicate
- `2751334` docs(env): document INTEGRATION_ENC_KEY and the Entra sync flags
- `e6c3609` fix(entra): a failed sync says what the tenant said, not "Internal Server Error"
- `7db4a19` feat(entra): log when the sync scheduler arms, not only when it declines
- `d64e24c` fix(entra): serialize sync per org, and stop a partial enumeration mass-retiring
- `cebcf3f` Merge: per-customer Entra/Intune device sync into the CMDB
- `1b71889` fix(db): create integration.credentials.manage in a migration, not only in seed

**Push 95** — 2026-09-03 16:29:48 UTC → `main` (`1b71889`..`8577f32`, 1 commit)
- `8577f32` docs(readme): document the device sync, and ignore Finder conflict copies

**Push 96** — 2026-09-03 16:46:34 UTC → `main` (`8577f32`..`3dc6d1f`, 1 commit)
- `3dc6d1f` feat(scripts): create the Anchor-Provisioning app registration, dry-run by default

**Push 97** — 2026-09-03 17:43:02 UTC → `main` (`3dc6d1f`..`cd98add`, 1 commit)
- `cd98add` feat(scripts): grant admin consent on a sovereign cloud, where the az shim fails

**Push 98** — 2026-09-03 17:58:21 UTC → `main` (`cd98add`..`afc0742`, 1 commit)
- `afc0742` feat(scripts): per-customer device-sync app registration, and a reusable consent path

**Push 99** — 2026-09-03 18:03:46 UTC → `main` (`afc0742`..`7f571af`, 1 commit)
- `7f571af` fix(scripts): print an absolute path for the follow-up consent command

**Push 100** — 2026-09-03 18:10:41 UTC → `main` (`7f571af`..`c34c382`, 1 commit)
- `c34c382` feat(entra): exclude personal (BYOD) devices from the CMDB

**Push 101** — 2026-09-03 18:24:21 UTC → `main` (`c34c382`..`c3bdd16`, 1 commit)
- `c3bdd16` fix(provisioning,entra): check TAP policy up front; stop the badge claiming a sync that cannot run

**Push 102** — 2026-09-03 18:38:10 UTC → `main` (`c3bdd16`..`c9876c0`, 1 commit)
- `c9876c0` fix(provisioning): the Windows 365 licence is conditional, like the Cloud PC itself

**Push 103** — 2026-09-03 18:48:08 UTC → `main` (`c9876c0`..`3dc790f`, 1 commit)
- `3dc790f` fix(entra,provisioning): close the sub-floor collapse gap the BYOD exclusion opened

**Push 104** — 2026-09-03 19:40:56 UTC → `main` (`3dc790f`..`961b1e2`, 1 commit)
- `961b1e2` fix(provisioning): set usageLocation, without which Graph refuses every licence

**Push 105** — 2026-09-03 20:10:26 UTC → `main` (`961b1e2`..`59eab6a`, 1 commit)
- `59eab6a` fix(provisioning): set givenName and surname, not just a display name

**Push 106** — 2026-09-03 20:21:17 UTC → `main` (`59eab6a`..`6220655`, 1 commit)
- `6220655` fix(web): stop the catalog dialog discarding a filled form, and pin Send in view

**Push 107** — 2026-09-03 20:41:27 UTC → `main` (`6220655`..`91f83e8`, 1 commit)
- `91f83e8` fix(db): clear terminal timestamps left on tickets that moved back to open

**Push 108** — 2026-09-03 20:42:56 UTC → `main` (`91f83e8`..`be37324`, 1 commit)
- `be37324` feat(entra): load a customer's Entra staff as Nexus users, without duplicating anyone

**Push 109** — 2026-09-03 21:09:25 UTC → `main` (`be37324`..`88dd1c1`, 1 commit)
- `88dd1c1` docs(kb): 16 GCC High end-user articles, written for the cloud we actually run

**Push 110** — 2026-09-03 21:49:49 UTC → `main` (`88dd1c1`..`138ff16`, 1 commit)
- `138ff16` fix(entra): match Entra identities globally, and load the SBS roster

**Push 111** — 2026-09-04 14:26:01 UTC → `main` (`138ff16`..`41f1a3d`, 1 commit)
- `41f1a3d` fix(web): the people picker had no way to close

**Push 112** — 2026-09-04 14:47:07 UTC → `main` (`41f1a3d`..`5c30492`, 1 commit)
- `5c30492` fix(web): portal the people-picker list so a scrolling dialog cannot clip it

**Push 113** — 2026-09-04 14:52:13 UTC → `main` (`5c30492`..`0e6a55b`, 1 commit)
- `0e6a55b` feat(provisioning): make the TAP lifetime configurable, and stop the email guessing it

**Push 114** — 2026-09-04 14:55:54 UTC → `main` (`0e6a55b`..`d422166`, 1 commit)
- `d422166` fix(kb): stored XSS in search snippets, reachable by any kb.author

**Push 115** — 2026-09-04 15:07:19 UTC → `main` (`d422166`..`026d5f0`, 1 commit)
- `026d5f0` feat(web): one Dialog primitive, replacing three copies and a native confirm

**Push 116** — 2026-09-04 15:10:33 UTC → `main` (`026d5f0`..`66201b4`, 1 commit)
- `66201b4` fix(web): give form controls accessible names, and stop ignoring reduced motion

**Push 117** — 2026-09-04 15:12:36 UTC → `main` (`66201b4`..`fa6a62c`, 1 commit)
- `fa6a62c` fix(web): stop danger red meaning two different things

**Push 118** — 2026-09-04 15:18:09 UTC → `main` (`fa6a62c`..`5730227`, 1 commit)
- `5730227` fix(web): finish the critique backlog — overlays, focus rings, honest dashboard

**Push 119** — 2026-09-04 15:25:27 UTC → `main` (`5730227`..`2f93286`, 1 commit)
- `2f93286` feat(forms): section long request forms, and fix the order they ask in

**Push 120** — 2026-09-04 15:44:22 UTC → `main` (`2f93286`..`dee1e5f`, 1 commit)
- `dee1e5f` fix(web): stop the status row turning a resolve into a reopen

**Push 121** — 2026-09-04 18:03:38 UTC → `main` (`dee1e5f`..`cc8cefd`, 1 commit)
- `cc8cefd` fix(scripts): make the user-sync dry run tell the truth about creates

**Push 122** — 2026-09-11 14:16:20 UTC → `main` (`cc8cefd`..`cf2316f`, 1 commit)
- `cf2316f` fix(forms): unblock the onboarding request — live-sourced selects, findable people, locatable errors

**Push 123** — 2026-09-11 14:35:29 UTC → `main` (`cf2316f`..`b5953de`, 1 commit)
- `b5953de` fix(web): an optional dropdown you cannot clear is a mandatory one

**Push 124** — 2026-09-11 14:47:08 UTC → `main` (`b5953de`..`a1c40ec`, 1 commit)
- `a1c40ec` fix(accounts): actually make provider staff findable — RLS was filtering them out

**Push 125** — 2026-09-11 15:13:29 UTC → `main` (`a1c40ec`..`ca1a134`, 1 commit)
- `ca1a134` fix(web): say when a typed name is not a selection, and retract errors once fixed

**Push 126** — 2026-09-11 15:38:36 UTC → `main` (`ca1a134`..`1ec8eb7`, 1 commit)
- `1ec8eb7` fix(posture): answer the cross-customer dashboard; feat(provisioning): .ctr UPNs for contractors

**Push 127** — 2026-09-11 15:50:11 UTC → `main` (`1ec8eb7`..`1a2965d`, 1 commit)
- `1a2965d` feat(provisioning): make "copy access from" actually copy access — carefully

**Push 128** — 2026-09-11 16:04:06 UTC → `main` (`1a2965d`..`a3ab09d`, 1 commit)
- `a3ab09d` fix(web): lift the people picker's results above the dialog backdrop

**Push 129** — 2026-09-11 16:26:16 UTC → `main` (`a3ab09d`..`c20e12d`, 1 commit)
- `c20e12d` fix(provisioning): stop throwing away the reason a TAP request failed

**Push 130** — 2026-09-11 16:32:15 UTC → `main` (`c20e12d`..`bacfeab`, 1 commit)
- `bacfeab` fix(scripts): derive the consent count instead of hardcoding "five"

**Push 131** — 2026-09-11 16:47:10 UTC → `main` (`bacfeab`..`274f9b7`, 1 commit)
- `274f9b7` feat(provisioning): put the rest of the intake on the directory record

**Push 132** — 2026-09-11 16:54:42 UTC → `main` (`274f9b7`..`f6c9f97`, 1 commit)
- `f6c9f97` feat(forms): choose security groups from the tenant instead of typing them

**Push 133** — 2026-09-11 17:22:11 UTC → `main` (`f6c9f97`..`7021b64`, 1 commit)
- `7021b64` fix(provisioning): make the first sign-in actually work

**Push 134** — 2026-09-11 17:29:14 UTC → `main` (`7021b64`..`fb2b8e9`, 1 commit)
- `fb2b8e9` feat(provisioning): offer a temporary password as the first credential

**Push 135** — 2026-09-11 17:40:16 UTC → `main` (`fb2b8e9`..`87cb4f6`, 1 commit)
- `87cb4f6` fix(provisioning): repair accounts left demanding an impossible password change

**Push 136** — 2026-09-11 17:47:02 UTC → `main` (`87cb4f6`..`f5e0fa9`, 1 commit)
- `f5e0fa9` fix(provisioning): stop asking Graph for a property it refuses to return

**Push 137** — 2026-09-11 17:54:47 UTC → `main` (`f5e0fa9`..`fd90e48`, 1 commit)
- `fd90e48` fix(provisioning): never let a best-effort repair fail the whole run

**Push 138** — 2026-09-11 18:54:00 UTC → `main` (`fd90e48`..`310c35b`, 1 commit)
- `310c35b` feat(csat): three-question survey answerable from the email, without signing in

**Push 139** — 2026-09-11 19:01:02 UTC → `main` (`310c35b`..`af01b34`, 1 commit)
- `af01b34` fix(web): unwrap the survey page params, which Next 15 hands over as a promise

**Push 140** — 2026-09-24 18:51:24 UTC → `main` (`af01b34`..`3b0b4b3`, 4 commits)
- `217ea5e` fix(admin): repair platform user administration and staff sign-in for roster-synced staff
- `2a8f11b` fix(provisioning): stop distribution lists failing onboarding and skipping Cloud PC/TAP
- `cd288d5` feat(tickets): show staff the full submitted request form on a ticket
- `3b0b4b3` fix(security): stop a customer admin from granting itself platform SuperAdmin

**Push 141** — 2026-09-30 14:30:18 UTC → `main` (`3b0b4b3`..`d39dd55`, 6 commits)
- `2448d74` fix(provisioning): copy IT on credential emails; stop mirrored admin groups blocking onboarding
- `7bc4e0b` feat(provisioning): send the SBS Microsoft 365 onboarding guide with the new user's credential
- `05d05f3` fix(provisioning): declare UTF-8 in the onboarding guide so checkboxes and dashes render
- `ca87d3d` fix(provisioning): make temporary-password mode work; drop distribution lists from onboarding
- `4d507b7` feat(provisioning): resend the onboarding email with a new temporary password
- `d39dd55` feat(tickets): let admins correct the answers on a submitted request

**Push 142** — 2026-09-30 14:36:15 UTC → `main` (`d39dd55`..`f28d914`, 1 commit)
- `f28d914` fix(web): stop one ticket card from crashing the whole ticket page

**Push 143** — 2026-09-30 14:38:05 UTC → `main` (`f28d914`..`585b738`, 1 commit)
- `585b738` fix(web): keep the Submitted form's pii reference null-safe after the sections guard

**Push 144** — 2026-09-30 14:50:04 UTC → `main` (`585b738`..`3d1041c`, 1 commit)
- `3d1041c` fix(web): allow resending onboarding credentials while a run awaits its Cloud PC

## Full commit log

All commits, oldest first, grouped by day. Stats are files changed / lines added / lines removed.

### 2026-06-11 — 48 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `531a6c6` | 14:41 | Initial commit | 1 | +1/−0 |
| `8b20ebd` | 16:24 | feat: Nexus Cyber platform — spec, runnable app, vendored UI, analytics | 94 | +17110/−1 |
| `e2e7c7c` | 16:43 | feat: service catalog, request-fulfillment workflows, tiered ownership, ConMon | 16 | +1234/−4 |
| `1a63138` | 17:00 | feat: enterprise hardening — on-call engine, tests, CI, security middleware | 21 | +5047/−2861 |
| `fead6e8` | 22:23 | feat: automation engine, idempotency, fix missing approvals table | 8 | +466/−3 |
| `74d32fe` | 22:28 | chore: vendor Superpowers skills (v5.1.0) into .claude/ | 51 | +8655/−0 |
| `4a143e6` | 22:36 | fix(oncall): resolve responders via system context; parametrize DB host port | 3 | +22/−16 |
| `e030e95` | 22:44 | docs: design spec for Nexus MVP-completion & enterprise hardening | 1 | +266/−0 |
| `d46d146` | 22:53 | feat: customer support portal, on-call rotation config, neutral+blue palette | 11 | +553/−47 |
| `86a4105` | 22:59 | feat(brand): recreate NexusCyber circuit logo; add favicon; use across platform | 8 | +102/−22 |
| `7508d74` | 23:01 | Merge pull request #1 from kmwhite40/feat/nexus-platform | 0 | +0/−0 |
| `4d2ce49` | 23:01 | docs: Tier 1 (security & compliance) implementation plan | 1 | +2152/−0 |
| `11d601e` | 23:06 | test: add skip-if-no-DB integration-test scaffolding | 2 | +24/−0 |
| `732c39e` | 23:07 | feat(ui): vendored Footer + split-screen auth pages (FloatingPaths) | 10 | +443/−195 |
| `2536ddf` | 23:11 | feat(compliance): control coverage, evidence export, posture exception SoD flow | 8 | +426/−3 |
| `15f4fe5` | 23:13 | docs: M365 GCC integration design spec (notifications + ingestion) | 1 | +171/−0 |
| `31f8d8c` | 23:15 | feat(audit): SIEM export (NDJSON/CEF) + hash-chain verification | 15 | +747/−9 |
| `5a1df7f` | 23:19 | feat(elevation): JIT privilege elevation + break-glass; deterministic audit ordering | 12 | +288/−10 |
| `f9e1bee` | 23:19 | docs: landing page redesign (simple & modern) design spec | 1 | +94/−0 |
| `76ba1a4` | 23:22 | docs: M365 GCC integration implementation plan (4 tiers) | 1 | +1997/−0 |
| `e948a67` | 23:23 | feat(attachments): secure upload/scan/scoped-download + concurrency-safe audit chain | 16 | +691/−36 |
| `fefa59d` | 23:24 | ci: Postgres service for integration tests + CodeQL, SBOM, dependency review; docs | 5 | +363/−6 |
| `390913c` | 23:25 | fix(automation): write add_internal_note to ticket_comments (internal), not a nonexistent table | 6 | +143/−203 |
| `0bf0062` | 23:25 | feat(m365): add M365 GCC config block + parser | 1 | +15/−0 |
| `e7344c5` | 23:29 | feat(m365): client-credentials token provider with caching | 2 | +115/−0 |
| `a303dc0` | 23:31 | feat(m365): Graph HTTP client with throttle/retry | 2 | +134/−0 |
| `4572dd6` | 23:33 | feat(m365): notification adapter interface + console dev adapter | 3 | +75/−0 |
| `173e87d` | 23:33 | feat(kb): Confluence-style knowledge base + canonical audit hashing | 17 | +1011/−14 |
| `cd2ba18` | 23:35 | feat(m365): migration for prefs, integration state, health, delivery columns | 1 | +40/−0 |
| `4060701` | 23:37 | feat(m365): per-event notification templates | 2 | +90/−0 |
| `0ff7177` | 23:37 | feat(tickets): linking + merge (JSM-style related issues) | 8 | +279/−3 |
| `569b5a2` | 23:39 | feat(m365): resolve notification recipients from domain context | 2 | +126/−0 |
| `321dc94` | 23:41 | feat(m365): Graph email + Teams adapter | 2 | +89/−0 |
| `bb9cd70` | 23:42 | feat(changes): change management + CAB with multi-step approvals & calendar | 15 | +655/−19 |
| `338efd6` | 23:44 | chore(brand): copyright punctuation — NexusCyber. A Strategic Business Systems Company. | 1 | +1/−1 |
| `c8efc4d` | 23:44 | feat(m365): real dispatcher (recipients + render + send + record) | 3 | +227/−45 |
| `4e6e4bd` | 23:44 | chore(brand): update copyright — operated as part of Strategic Business Systems, Inc. | 1 | +1/−1 |
| `8b3b259` | 23:47 | feat(problems): ITIL problem management with known-error + incident clustering | 9 | +492/−4 |
| `41746fe` | 23:50 | fix(m365): Teams posts once per dispatch; runtime retries on transient error; per-channel skipped records | 3 | +44/−7 |
| `1c13b20` | 23:50 | feat(csat): satisfaction surveys on ticket resolution | 8 | +253/−1 |
| `43949b4` | 23:52 | feat(m365): inbound mail ingestion (delta fetch + message->ticket) | 2 | +188/−0 |
| `4bf9f3e` | 23:53 | feat(queues): saved agent work queues with SLA-aware sorting (JSM parity) | 10 | +355/−2 |
| `9c45a30` | 23:54 | feat(m365): mail-ingest scheduler wired into server | 1 | +4/−0 |
| `08e3af9` | 23:56 | feat(m365): integration health probes + test service | 3 | +127/−0 |
| `4fc286f` | 23:57 | docs: Jira-parity feature build design spec | 1 | +224/−0 |
| `98140ca` | 23:57 | feat(m365): health + test integration routes | 1 | +15/−0 |
| `926586a` | 23:58 | feat(observability): Prometheus /metrics + README; finalize JSM/Confluence parity | 5 | +135/−4 |
| `561f064` | 23:59 | docs(m365): README notes for GCC notifications + dev transport | 1 | +11/−0 |

### 2026-06-12 — 108 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `505bbcc` | 00:04 | fix(m365): HTML-escape user data in notification email/Teams bodies | 3 | +34/−2 |
| `48f39a9` | 00:05 | docs: Jira-parity Phase 1 implementation plan (wire-ups) | 1 | +1078/−0 |
| `9b1838b` | 00:07 | feat(authz): add queue.read/service/org/notifications permissions + grants | 1 | +10/−3 |
| `fd1f9b4` | 00:11 | feat(sla): pause/resume + holiday calendars (Tier-2 WP6) | 6 | +243/−8 |
| `6b95dce` | 00:13 | feat(cmdb): services + configuration-items API, client, and /services page | 4 | +183/−0 |
| `220266c` | 00:14 | feat(worklogs): ticket time tracking (JSM parity) | 6 | +156/−0 |
| `5d50624` | 00:16 | feat(automation): gated-action approvals (Tier-2 WP8) | 4 | +203/−8 |
| `d4647b1` | 00:18 | feat(canned): reusable canned responses with placeholder rendering (JSM parity) | 5 | +170/−0 |
| `3f6a71c` | 00:18 | fix(cmdb): validate service POST bodies, align kind default, label criticality | 3 | +10/−6 |
| `98b007a` | 00:20 | fix(m365): resolve specific responder for oncall notifications | 2 | +26/−0 |
| `67b1dbf` | 00:21 | feat(tickets): bulk actions (JSM parity) | 4 | +187/−0 |
| `248daaf` | 00:21 | feat(customers): org detail/update/users API, client, and /customers page | 4 | +133/−2 |
| `9ccc3da` | 00:23 | feat(tickets): participants/watchers + @mentions (JSM A10) | 5 | +214/−0 |
| `7367111` | 00:24 | feat(ops): runbook scripts (smoke, db backup/restore) + REST API collection | 7 | +287/−2 |
| `3235a46` | 00:26 | feat(workflows): configurable ticket status workflows (JSM A7) | 6 | +300/−15 |
| `2840ae7` | 00:28 | fix(tickets): serialize ticket-number allocation under concurrency | 2 | +8/−2 |
| `1f7a515` | 00:29 | fix(customers): enum-validate cloud, return safe org columns, surface detail load errors | 3 | +40/−25 |
| `e0162ec` | 00:33 | feat(notifications): delivery log query API, client, and /email-logs page | 4 | +115/−1 |
| `fc2e674` | 01:40 | fix(notifications): validate/clamp deliveries query limit (prevent LIMIT -1 bypass) | 2 | +8/−2 |
| `b7fbf6b` | 01:41 | feat(incidents): /incidents view (tickets filtered to type=incident) | 1 | +42/−0 |
| `8001f80` | 01:44 | feat(nav): surface incidents, services, customers, email-logs in agent nav | 1 | +12/−0 |
| `8ada8be` | 01:50 | fix(phase1): wire ticket type filter, authorize service reads, allow org.read to list orgs | 3 | +10/−2 |
| `761c646` | 07:54 | ci(docker): build, smoke-test, and publish container images to GHCR | 1 | +137/−0 |
| `4605150` | 07:54 | feat(forms): custom request forms & field validation (JSM A4) | 6 | +337/−4 |
| `d7e5cba` | 07:56 | docs: Jira-parity Phase 2 implementation plan (alerts, channels, dashboards) | 1 | +832/−0 |
| `a83cc37` | 07:57 | feat(authz): add alert/channel/dashboard permissions + grants | 1 | +11/−3 |
| `6d1e0de` | 07:59 | feat(alerts): alerts table + RLS + open-alert dedup index | 1 | +28/−0 |
| `3481d2b` | 08:00 | feat(alerts): alert state-machine + tests | 2 | +42/−0 |
| `f5027a4` | 08:01 | feat(announcements): portal announcements + idempotency fixes | 6 | +207/−5 |
| `9a2d8cf` | 08:03 | feat(alerts): ingest/ack/resolve/escalate API, client, and /alerts feed | 4 | +153/−0 |
| `47620ec` | 08:07 | fix(alerts): explicit column lists (drop SELECT */RETURNING *) | 1 | +8/−5 |
| `3fff542` | 08:09 | feat(channels): channels table + RLS | 1 | +17/−0 |
| `aad157f` | 08:10 | feat(channels): channel CRUD API, client, and /channels page | 4 | +94/−0 |
| `54f447c` | 08:13 | feat(dashboards): dashboards table + RLS + seeded default per org | 1 | +21/−0 |
| `409da71` | 08:15 | feat(dashboards): named dashboards CRUD + widget catalog API, client, and /dashboards page | 5 | +147/−0 |
| `f0eb02e` | 08:17 | feat(nav): surface alerts, channels, dashboards in agent nav | 1 | +9/−0 |
| `f4afaf0` | 08:27 | docs: Jira-parity Phase 3 implementation plan (IA/nav) | 1 | +276/−0 |
| `206a3e4` | 08:28 | feat(get-started): in-app quick-start surface | 1 | +39/−0 |
| `9722a8b` | 08:29 | feat(archived): closed/archived work items view | 1 | +36/−0 |
| `dbcc3a6` | 08:31 | feat(nav): group agent sidebar into Work/Operations/Insights/Security sections; add Get started + Archived | 1 | +58/−34 |
| `009766d` | 08:32 | fix(nav): allow the longer sectioned sidebar to scroll (overflow-y-auto) | 1 | +1/−1 |
| `c4650ea` | 08:47 | fix(authz): grant ticket.create to ServiceDeskManager so alert escalation can open a ticket | 1 | +1/−1 |
| `987be77` | 08:58 | feat(deploy): Azure Government App Service (Web Apps for Containers) deployment | 5 | +499/−1 |
| `43fd01d` | 09:07 | fix(db): resolve admin-pool deadlock in auth path (blank catalog/hung requests) | 3 | +44/−5 |
| `b5b7100` | 09:13 | feat(catalog): add M365/Azure/AWS gov-cloud service catalog items | 1 | +125/−0 |
| `d05ffbe` | 09:25 | feat(deploy): support Azure App Service "Code" (Node 20-LTS) deploy + workflow | 4 | +146/−2 |
| `6764769` | 09:42 | ci(deploy): build apps/web in CI for Azure Code deploy (reliable on F1) | 1 | +26/−12 |
| `c2e2a5d` | 09:42 | ci(deploy): drop GitHub Environment gate from web deploy workflow | 1 | +0/−1 |
| `bf2c3eb` | 09:55 | ci(deploy): use Entra OIDC for web deploy (gov disables basic auth) | 2 | +67/−23 |
| `5d7c280` | 10:45 | infra(azure-gov): add API-only bicep for Anchor backend (KV-free, gov-policy-compliant) | 2 | +176/−0 |
| `07583cc` | 10:52 | docs(auth): scope Entra ID (Azure Gov) OIDC for the agent plane | 1 | +95/−0 |
| `ac42aa6` | 11:02 | feat(auth): Entra ID (Azure Gov) OIDC for the agent plane (Phase 1, disabled by default) | 12 | +495/−1 |
| `6921aa6` | 12:03 | docs(auth): add customer multi-tenant Entra OIDC plan + config guide | 2 | +199/−0 |
| `7a4e5b4` | 12:13 | feat(auth): Phase 2 — multitenant customer Entra OIDC (disabled by default) | 9 | +395/−82 |
| `1609fb3` | 13:06 | feat(api): admin create-org endpoint to onboard customer tenants for SSO | 2 | +52/−0 |
| `0365822` | 13:13 | fix(auth): surface the rejected tenant id in the customer-SSO not-onboarded error | 1 | +3/−1 |
| `63e5a5b` | 13:33 | feat(api): admin DELETE /organizations/:id (refuses if org has users) | 2 | +33/−0 |
| `5e5dd29` | 13:35 | feat(web): Microsoft logo on the two SSO buttons (agent + customer) | 1 | +14/−0 |
| `c582749` | 13:39 | feat(web): rename agent SSO button to "Sign in as Anchor staff"; drop signup link | 2 | +2/−6 |
| `ee5d565` | 13:43 | feat(web): real Terms of Service and Privacy Policy pages | 4 | +315/−2 |
| `4011774` | 13:49 | fix(api): make admin org-delete clear non-cascade child rows first | 1 | +12/−0 |
| `268c3f5` | 13:52 | feat(notifications): make email a supported channel for GCC | 1 | +8/−0 |
| `9f14f76` | 13:55 | feat(auth): SuperAdmin role + platform-admin bootstrap; superuser is cross-org; rename SSO button to "Sign in as Admin" | 4 | +36/−2 |
| `51b628c` | 14:00 | feat(notifications): event-aware recipient routing (agents on new ticket, customer on updates) | 4 | +215/−41 |
| `37bc980` | 14:12 | feat(notifications): new tickets notify a shared desk mailbox, not every agent | 5 | +55/−12 |
| `dd1a318` | 14:16 | feat(demo): single Demo Corp + admin<->customer toggle account; gate demo seed | 21 | +410/−286 |
| `4cd5567` | 14:20 | feat(retention): purge resolved incidents/problems/changes after 30 days | 3 | +83/−0 |
| `add6a5a` | 14:22 | fix(authz): make platform-superuser cross-org consistent across PDP and RLS | 5 | +68/−3 |
| `68cfb1b` | 14:35 | feat(content): expand service catalog (+13 items) and knowledge base (5 spaces, ~25 articles) | 2 | +287/−24 |
| `1d1d265` | 14:38 | feat(catalog): add Request new software, Report broken hardware, Request new hardware | 1 | +45/−2 |
| `21d2cf1` | 14:44 | feat(admin): platform admin UI for customers/users + catalog items (offboard, security/outage) | 5 | +450/−55 |
| `08dcda0` | 14:46 | docs: catalog custom request forms design spec | 1 | +170/−0 |
| `06f235a` | 14:51 | feat(portal): featured-services showcase using DisplayCards (offboard/security/outage) | 1 | +41/−0 |
| `0b9ab27` | 14:53 | fix(portal): make 'Search common requests' actually search the knowledge base | 1 | +50/−7 |
| `b940aae` | 14:54 | docs: catalog request forms implementation plan (3 tiers) | 1 | +1070/−0 |
| `4e1ab34` | 14:55 | feat(forms): migration — catalog form link, people/attachment field types, seed new-user form | 1 | +34/−0 |
| `2a821f2` | 14:58 | feat(api): force option on org delete to remove an org's users too | 4 | +64/−12 |
| `e1079ec` | 15:03 | feat(forms): GET /catalog/:key/form endpoint | 2 | +25/−0 |
| `3775c9e` | 15:05 | feat(forms): GET /users/search for people pickers (org-scoped) | 3 | +61/−0 |
| `5ce0bd3` | 15:06 | feat(forms): mapFormAnswers — route answers to ticket/approvals/custom_fields | 2 | +85/−0 |
| `3af1e91` | 15:09 | feat(forms): route form answers in createRequest (requester, custom_fields, approval steps) | 2 | +50/−11 |
| `f63ee9b` | 15:27 | feat(web): api client — catalog.form, users.search, attachment upload | 1 | +47/−2 |
| `7e7483e` | 15:29 | feat(web): UserPicker people-picker component | 1 | +88/−0 |
| `c755226` | 15:31 | feat(web): dynamic request form in catalog modal (pickers, system, attachment) | 1 | +68/−23 |
| `6eb6a79` | 17:45 | docs: Phase 2 hardening design spec (live widgets, create UIs, integration tests) | 1 | +53/−0 |
| `6a271ad` | 17:47 | docs: Phase 2 hardening implementation plan (tests, widgets, create UIs) | 1 | +569/−0 |
| `f66c787` | 17:52 | test(phase2): integration tests for services/channels/dashboards/alerts | 4 | +169/−0 |
| `67eae81` | 17:55 | fix(dashboards): seed default dashboard per org in seed.ts (migration ran before orgs existed) | 1 | +10/−0 |
| `4d332de` | 17:57 | feat(dashboards): render widgets with live data (KPIs, posture, volume, findings, recent tickets) | 2 | +139/−11 |
| `cf94585` | 17:59 | feat(channels): New channel create modal | 1 | +41/−3 |
| `c0fb5cd` | 18:00 | feat(dashboards): New dashboard create modal (name + widget picker) | 1 | +47/−1 |
| `80f97af` | 18:04 | fix(dashboards): guard create-reload with catch; stabilize widget keys | 1 | +2/−2 |
| `89bf1f5` | 18:04 | test(services): assert ticket_count is a number, not just present | 1 | +3/−1 |
| `3b01614` | 18:15 | feat(forms): request forms for group/guest/PIM/keyvault/identity-center/license items | 1 | +136/−0 |
| `e0afad7` | 18:15 | ops(deploy): repeatable web deploy script + fix CI packaging for standalone | 3 | +106/−4 |
| `b406f0c` | 18:24 | feat(forms): offboarding form (affected-user mapping; requester = submitter) | 4 | +44/−2 |
| `bdd4454` | 18:25 | ops(deploy): fix Azure web-deploy trigger to match the OIDC credential branch | 1 | +5/−2 |
| `252fc6d` | 19:48 | fix(web): isolate deploy build into NEXT_DIST_DIR so it never clobbers dev .next | 3 | +18/−9 |
| `c497d0e` | 20:02 | docs: competitive gap analysis + enterprise roadmap | 1 | +58/−0 |
| `2c181f0` | 20:04 | docs: escalation policies implementation plan | 1 | +205/−0 |
| `a99d80a` | 20:06 | feat(authz): escalation.read/manage permissions | 1 | +6/−4 |
| `e90e7a2` | 20:06 | feat(db): 0035 escalation_policies table with RLS | 1 | +16/−0 |
| `47b866c` | 20:07 | feat(web): ticket attachments UI (upload/list/download) for customers and agents | 3 | +152/−0 |
| `848558f` | 20:07 | feat(escalation): pure step logic + CRUD module (TDD) | 2 | +125/−0 |
| `7adf774` | 20:10 | feat(escalation): routes, client helpers, /escalation-policies page, nav entry | 4 | +130/−0 |
| `3b33955` | 20:13 | feat(escalation): integration test; fix user lookup via withSystemContext (nexus-plane RLS) | 2 | +87/−2 |
| `876d86c` | 20:13 | feat(catalog): structured intake forms for M365 offboard + security/outage/phishing | 1 | +95/−0 |
| `69d0bbd` | 20:52 | feat(catalog): comprehensive onboarding intake + forms for remaining catalog items | 1 | +159/−0 |

### 2026-06-13 — 11 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `ef0cf0d` | 06:25 | fix(api/web): empty-body DELETE returned 500; add force-delete for populated orgs | 3 | +41/−8 |
| `b939829` | 06:30 | fix(api): strip application/json content-type on empty-body requests (onRequest hook) | 1 | +8/−12 |
| `1f12f20` | 06:47 | feat(demo): working demo toggle account (agent <-> customer) for gov | 1 | +37/−0 |
| `c94fa32` | 07:07 | feat(oncall): delete schedules, remove responders, cell numbers + sample escalation policies | 8 | +279/−12 |
| `1710b6b` | 07:17 | feat(kb,web): M365/AWS/Azure + self-help KB articles; light/dark mode | 6 | +131/−5 |
| `3021d50` | 07:42 | fix(kb): render inline **bold**, `code`, links, and fenced code blocks | 1 | +52/−9 |
| `a806782` | 08:02 | fix(mail): emailed tickets now generate no-reply notifications | 7 | +129/−6 |
| `e2f0f9f` | 08:41 | feat(mail): prime delta cursor on first ingest run (skip existing inbox) | 2 | +41/−12 |
| `cecf73c` | 09:39 | feat(mail): rich customer acknowledgment (name, ticket id, summary, time, priority) | 5 | +106/−20 |
| `e0b837c` | 14:44 | feat(mail): customer notifications for agent reply, resolution, and CSAT | 7 | +210/−14 |
| `0e648d0` | 16:58 | feat(mail): Tier-2 customer notifications — assigned, closed, reopened, approvals | 6 | +119/−14 |

### 2026-06-14 — 11 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `7446949` | 06:57 | feat(mail): mark GCC High email channel supported (capability gate) | 1 | +8/−0 |
| `9faaf32` | 06:59 | chore(web): install official Anthropic frontend-design skill; remove Pricing & Docs nav links | 2 | +42/−2 |
| `957708e` | 07:04 | feat(web): cohesive type system — Public Sans + JetBrains Mono (self-hosted) | 4 | +40/−11 |
| `99be606` | 07:19 | fix(csat): make 'rate your experience' work for any resolved ticket | 4 | +127/−26 |
| `e03e03d` | 07:33 | fix(mail): notify requester + support team on new ticket (all channels) | 5 | +41/−11 |
| `14834cf` | 07:50 | fix(sla): mark response SLA met on first response (was always breaching) | 3 | +65/−1 |
| `7b60c24` | 07:58 | feat(dashboards): enterprise KPI/SLA/operations dashboards | 5 | +380/−21 |
| `5ea4fda` | 08:18 | feat(dashboards): add Team, Customer portfolio, Posture & compliance, On-call & change | 4 | +380/−109 |
| `63c9124` | 11:59 | feat(mail): thread inbound email replies onto the existing ticket | 2 | +110/−1 |
| `173fe16` | 11:59 | feat(ops): notification delivery-health dashboard + codified API deploy | 5 | +156/−2 |
| `85e80c6` | 15:38 | feat(reliability): notification send-retry + in-boundary migrate-on-boot | 4 | +64/−15 |

### 2026-06-15 — 10 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `0d3d167` | 08:03 | feat(brand): new Anchor logo + favicon across the app | 6 | +67/−68 |
| `37020a0` | 08:10 | chore(web): remove 'Get started' hero CTA on the landing page | 1 | +1/−8 |
| `020ccc1` | 08:22 | chore(web): remove 'Get started' signup button from the landing nav | 2 | +14/−10 |
| `56f135b` | 08:31 | feat(web): add full Anchor lockup (mark + ITSM Platform tagline) to landing hero | 1 | +4/−0 |
| `6f5561b` | 08:40 | style(web): enlarge landing hero lockup, reduce headline size for balance | 1 | +3/−3 |
| `85cc8eb` | 08:50 | feat(brand): use exact Anchor logo pack assets + refine landing hero | 11 | +29/−83 |
| `5a89345` | 08:53 | feat(web): Gov-cloud-only landing — drop headline + all 'Commercial' copy | 17 | +14/−7 |
| `7490ad6` | 08:56 | fix(brand): transparent mark (knock out white bg) + remove hero eyebrow/headline | 5 | +1/−4 |
| `657d5ab` | 09:03 | feat(web): minimal logo-only landing hero (remove subtitle) | 1 | +2/−6 |
| `171793f` | 09:27 | chore(web): drop 'Commercial' from site metadata description (Gov-cloud only) | 1 | +1/−1 |

### 2026-06-25 — 37 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `46dfd75` | 10:23 | docs: release newsletter + mgmt brief, ServiceNow parity plan, HelpDesk guides | 9 | +502/−0 |
| `ef2eb34` | 10:23 | feat(web): stacked, larger, centered landing logo | 2 | +51/−12 |
| `ce36fa4` | 10:23 | feat(catalog): User Device Intune Enrollment item + portal search deep-link | 3 | +70/−2 |
| `0879020` | 10:23 | feat: platform user administration (ServiceNow parity Phase 1) | 15 | +721/−11 |
| `aff318f` | 10:35 | feat(web): change calendar month view (Phase 2) | 1 | +121/−1 |
| `e7a4dde` | 10:35 | feat(cmdb): CI attributes, ownership & relationships (Phase 2) | 5 | +352/−32 |
| `eb3e39d` | 10:51 | feat: flow designer, report builder & virtual agent (Phases 3-4) | 7 | +481/−43 |
| `f4486b6` | 11:01 | feat(kb): add global Help Desk self-service articles | 2 | +390/−0 |
| `769f145` | 11:31 | docs: update NexusCyber Hotline number to (800) 265-6446 | 3 | +0/−0 |
| `fa5aff4` | 11:31 | feat(web): site-entry welcome dialog + rolling hotline banner | 3 | +174/−1 |
| `297a60a` | 11:47 | fix(kb): audit fixes — dedupe, security URLs/contact, tag hygiene, gap-fill | 3 | +269/−6 |
| `23bfecd` | 11:54 | feat(web): add CUI/sensitive-data warning to rolling banner | 1 | +14/−8 |
| `ae706af` | 12:04 | feat(kb): article 'did this resolve your issue?' deflection + deep-linking | 5 | +88/−3 |
| `1cfc987` | 12:08 | fix(web): show welcome dialog once per login for every user | 2 | +12/−4 |
| `92df47f` | 14:02 | docs: Anchor change-log newsletter (June 25, 2026) | 1 | +177/−0 |
| `e1dd763` | 14:06 | docs: next-level platform review + 'how to create a ticket' walkthrough | 2 | +342/−0 |
| `f2e75cf` | 14:14 | feat(web): serve ticket walkthrough in-app + skippable portal prompt | 2 | +308/−0 |
| `55bfbbd` | 14:41 | docs: design spec — CMDB self-population via per-customer Entra/Intune device sync | 1 | +126/−0 |
| `05daa95` | 14:52 | docs: implementation plan — CMDB Entra/Intune device sync | 1 | +1184/−0 |
| `be791ed` | 15:05 | fix(kb): close 7 editorial gaps in help-center articles | 3 | +160/−16 |
| `2f5c55c` | 15:58 | feat(sla): align severity SLA matrix to published 8x5 service levels | 2 | +11/−6 |
| `9221cc7` | 15:58 | docs: Anchor exec briefing deck, feature one-pager (+PDF) and intro email | 5 | +933/−0 |
| `26377c9` | 19:55 | feat(web): premium customer-facing homepage + app-wide aesthetic pass | 20 | +703/−280 |
| `60b1404` | 20:15 | fix(web): enlarge landing/footer typography + replace fabricated hero stats | 1 | +50/−50 |
| `3324894` | 20:25 | style(web): nudge landing typography up one more step | 1 | +9/−9 |
| `0f056f7` | 21:34 | chore(security): upgrade Next.js 14.2.35 -> 15.5.19; bump CI actions | 5 | +663/−110 |
| `7407f76` | 21:48 | fix(web): add customer selector to posture & compliance (fix blank pages) | 3 | +214/−150 |
| `2480c60` | 21:58 | feat(billing): admin-only per-customer utilization & overage billing portal | 6 | +559/−0 |
| `b1bc9aa` | 22:12 | chore(security): migrate API fastify 4 -> 5 (clears fast-uri HIGH) | 2 | +360/−239 |
| `08e76d5` | 22:15 | feat(intune): Anchor IT Support shortcut + Intune deployment package | 6 | +185/−0 |
| `5c09127` | 22:27 | docs: design spec — enterprise change management + CAB quorum voting | 1 | +260/−0 |
| `53fbb88` | 22:33 | docs: implementation plan — enterprise change management + CAB voting | 1 | +419/−0 |
| `c6f9385` | 22:36 | feat(changes): pure CAB voting resolver + risk derivation | 2 | +104/−1 |
| `ba8f7ad` | 22:38 | feat(db): CAB voting subsystem schema + permissions (0052) | 1 | +145/−0 |
| `5797671` | 22:45 | feat(integration): Anchor two-way sync — M2M API keys, idempotent ticket upsert, outbound webhooks | 12 | +911/−8 |
| `7dda20e` | 22:56 | feat(changes): CAB board administration module | 1 | +192/−0 |
| `6c81404` | 22:56 | chore(web): refresh generated next-env.d.ts + tsbuildinfo | 2 | +3/−2 |

### 2026-09-01 — 48 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `03648fe` | 13:54 | fix(deps): clear prod-reachable security advisories | 2 | +256/−216 |
| `c2b4dd5` | 14:31 | docs: design spec — SBS new-user onboarding + Entra/Cloud PC provisioning | 1 | +314/−0 |
| `e6190ff` | 14:39 | docs: implementation plan — SBS onboarding + Entra/Cloud PC provisioning | 1 | +2072/−0 |
| `07c463b` | 14:44 | feat(forms): email/phone field types + visible_when, sensitive, options_source columns | 4 | +55/−9 |
| `adb0c1a` | 14:48 | fix(forms): require at least one digit in phone validator | 2 | +7/−1 |
| `5c2a624` | 15:00 | feat(forms): conditional field visibility via visible_when | 2 | +41/−0 |
| `4c4347c` | 15:03 | feat(pii): sensitive-field storage with pii.view permission and audited reads | 3 | +145/−0 |
| `390e035` | 15:08 | feat(pii): route sensitive answers out of custom_fields; add audited read endpoint | 3 | +58/−3 |
| `951359a` | 15:11 | feat(pii): purge sensitive onboarding fields once the ticket closes | 2 | +22/−0 |
| `b6d06a3` | 15:16 | feat(forms): seed SBS new-user onboarding fields with conditional and sensitive flags | 1 | +39/−0 |
| `64664e4` | 15:18 | fix(forms): delete superseded manager field on user_onboarding | 1 | +4/−0 |
| `1a85af4` | 15:29 | feat(web): extract DynamicFormField with conditional visibility and email/phone types | 3 | +158/−34 |
| `21de7bb` | 15:49 | fix(pii): enforce the sensitive-field guarantee on the catalog intake path | 16 | +719/−78 |
| `8209c95` | 15:58 | feat(graph): add PATCH verb and selectable API version | 2 | +32/−2 |
| `61ed1fa` | 16:01 | feat(provisioning): configuration parsed from M365_PROV_* env | 2 | +47/−0 |
| `ed40cd7` | 16:05 | feat(provisioning): Graph adapter for users, licenses, groups, TAP, Cloud PC | 2 | +337/−0 |
| `08f4870` | 16:10 | feat(provisioning): pure planner with UPN derivation, SKU resolution, and blockers | 2 | +196/−0 |
| `2aaf8f7` | 16:16 | fix(provisioning): planner isolation + empty-local-part UPN guard | 2 | +55/−5 |
| `24ec172` | 16:20 | feat(db): provisioning runs and steps with provisioning.execute permission | 1 | +50/−0 |
| `07733a4` | 16:24 | fix(db): add organization_id and RLS to provisioning_steps table | 1 | +19/−5 |
| `b2d0daf` | 16:28 | feat(provisioning): idempotent step executor with adoption and delta licensing | 2 | +325/−0 |
| `722677f` | 16:34 | fix(provisioning): redact secrets from step errors, guard userId, validate group ids | 2 | +185/−16 |
| `13d7132` | 16:40 | feat(provisioning): Cloud PC poller with deadline handling | 3 | +234/−0 |
| `d176e34` | 16:44 | fix(provisioning): make Cloud PC Graph API version configurable | 3 | +35/−4 |
| `c1cd870` | 16:56 | feat(provisioning): preview/execute service and HTTP routes | 6 | +852/−65 |
| `db04c3d` | 17:07 | fix(provisioning): in-flight guard covers awaiting_cloudpc; pin the safety invariants | 3 | +497/−10 |
| `c1ca63b` | 17:14 | feat(db): 0057 — at most one in-flight provisioning run per ticket | 3 | +128/−16 |
| `0fafa0c` | 17:19 | feat(web): provisioning panel with dry-run preview and blocker gating | 2 | +258/−0 |
| `9205029` | 17:26 | fix(web): unwrap the {data} envelope in the provisioning panel; a11y for blocker reason | 1 | +14/−6 |
| `7bedd0e` | 17:49 | fix(retention): guard PII destruction tombstones per record | 2 | +87/−10 |
| `d2548e9` | 17:49 | fix(provisioning): bind execute to the approved preview, close the fail-open paths | 14 | +1082/−55 |
| `0b3d62a` | 17:53 | fix(provisioning): scope the supervisor lookup by org only, not by plane | 2 | +66/−29 |
| `61eeb93` | 21:28 | fix(db): explicit GRANTs for ticket_sensitive_fields + provisioning tables | 1 | +22/−0 |
| `140b93a` | 21:28 | fix(tickets): block PII-shaped keys in M2M-supplied custom_fields | 3 | +225/−0 |
| `31dc956` | 21:36 | test(api): prove supervisor org-scoping predicate against real Postgres | 1 | +176/−0 |
| `8262490` | 21:47 | test(web): add Vitest runner, pin form-visibility to shared fixtures, guard provisioning envelope unwrap | 7 | +1618/−6 |
| `7b063bc` | 21:57 | feat(changes): quorum voting, comments, cancel, PIR endpoints | 6 | +712/−98 |
| `37e0a83` | 22:12 | fix(cab): gate global CAB rows, serialize votes, enforce SoD | 11 | +584/−98 |
| `184b297` | 22:24 | feat(cab): persist the requested quorum so a clamped vote stays visible | 3 | +27/−2 |
| `8c1ea6a` | 22:25 | refactor(changes): extract ChangeCalendar + ChangeList, add a typed changes client | 4 | +454/−162 |
| `348268d` | 22:29 | feat(changes): CAB vote panel — tally, quorum, recusal, ballots | 5 | +587/−34 |
| `d8ddc5e` | 22:31 | feat(changes): ChangeDetail — plans, risk provenance, deliberation, PIR, cancel | 4 | +498/−105 |
| `e93c076` | 22:35 | feat(cab): CAB administration UI — board, blackouts, templates | 2 | +671/−0 |
| `6dd6274` | 22:39 | feat(changes): list \| calendar \| CAB settings tabs | 2 | +130/−4 |
| `1ad3ef7` | 22:40 | fix(changes): do not leave the vote panel disabled when the refetch fails | 1 | +3/−0 |
| `4c720ec` | 22:51 | fix(cab): stop the board editor from silently resetting member vote weights | 6 | +192/−35 |
| `f7ba75e` | 23:22 | fix(cab): the board can no longer be bypassed or packed by the raiser | 18 | +946/−81 |
| `95a37b0` | 23:35 | fix(cab): the CRITICAL-1 fix now holds on legacy data | 8 | +188/−9 |

### 2026-09-02 — 54 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `8b20af0` | 02:25 | docs: tenant probe script, CAB deployment runbook, app-registration guide | 4 | +933/−0 |
| `8f57dd5` | 02:37 | feat(changes): CAB notifications + deadline escalation sweeper | 10 | +488/−1 |
| `b9faefa` | 02:45 | fix(changes): CAB notifications fix round 1 — tenant-scope test rigor + sweeper hardening | 4 | +59/−26 |
| `35f4f73` | 06:43 | fix(provisioning): normalize SKU/policy/group matching against invisible tenant chars | 6 | +255/−29 |
| `f32b44d` | 06:48 | fix(web): stop the changes page tests exiting non-zero on a bad mock | 1 | +33/−5 |
| `708b7ff` | 07:10 | fix(tickets): serialize ticket-number allocation on all three create paths | 4 | +138/−34 |
| `e3d918e` | 07:17 | fix(tickets): commit dedupe marker atomically with ingest ticket, harden rollback | 2 | +61/−4 |
| `b136db8` | 07:10 | fix(tickets): serialize ticket-number allocation on all three create paths *(branch only)* | 4 | +138/−34 |
| `98ae7ef` | 07:17 | fix(tickets): commit dedupe marker atomically with ingest ticket, harden rollback *(branch only)* | 2 | +61/−4 |
| `c9878e3` | 07:44 | docs(readme): cover provisioning, CAB voting, and the web test suite | 1 | +75/−2 |
| `bcbc1b7` | 07:51 | docs(readme): spell out both dev-database invocation traps | 1 | +16/−3 |
| `1d5c002` | 12:52 | fix(notifications): make the new-ticket desk email carry the real record | 7 | +218/−16 |
| `b1627f1` | 12:58 | feat(provisioning): say when the feature is off instead of offering a dead button | 5 | +121/−5 |
| `81ba070` | 15:06 | docs(offboarding): design for the SBS offboarding engine (phase 1) | 1 | +160/−0 |
| `511a3d6` | 15:07 | fix(ingest): make a mail-driven reopen legal, visible, and clean | 2 | +99/−4 |
| `aa6b2c0` | 15:10 | fix(seed): link catalog items to their request forms | 2 | +103/−0 |
| `b9c51ea` | 15:16 | docs(offboarding): resolve the two open questions in the phase-1 design | 1 | +28/−6 |
| `bb8366f` | 15:21 | docs(offboarding): implementation plan for phase 1 | 1 | +1411/−0 |
| `2b417d4` | 15:24 | feat(offboarding): widen provisioning runs for offboarding kind and scheduling | 2 | +85/−0 |
| `fb273c1` | 15:25 | feat(offboarding): the ZZ_Inactive rename convention as a pure function | 2 | +60/−0 |
| `b204591` | 15:27 | feat(offboarding): planner with fixed step order and refusal blockers | 2 | +226/−1 |
| `fcb469e` | 15:27 | feat(offboarding): fingerprint binding an approved plan to its exact writes | 2 | +52/−1 |
| `c9717e8` | 15:29 | feat(offboarding): Graph operations for disable, revoke, rename, delicense, degroup | 4 | +138/−1 |
| `bdce86a` | 15:30 | feat(offboarding): executor halting at the manual mailbox step | 2 | +184/−0 |
| `53ef022` | 15:33 | feat(offboarding): service layer with one planning path and scheduling | 3 | +476/−0 |
| `73e5f67` | 15:35 | feat(offboarding): scheduled sweeper that still disables on plan drift | 3 | +299/−0 |
| `1307663` | 15:41 | feat(offboarding): intake captures a disable instant, not a bare date | 8 | +200/−4 |
| `f856c61` | 15:44 | feat(offboarding): ticket panel for preview and scheduling | 3 | +415/−0 |
| `790c93b` | 16:02 | fix(offboarding): gate offboarding separately from onboarding | 6 | +102/−11 |
| `2f7a52f` | 16:02 | docs(offboarding): record the two-gate correction in the spec and plan | 2 | +11/−1 |
| `e3b7a99` | 16:02 | Merge offboarding phase 1: M365 teardown behind a scheduled, approved plan | 0 | +0/−0 |
| `6ed73c7` | 16:20 | fix(tickets): clear terminal stamps on reopen, repair whitespace in ticket numbers | 4 | +184/−2 |
| `60a6f06` | 17:13 | feat(catalog): dual-write the catalog->form links, with an invariant test | 2 | +96/−0 |
| `8c9527e` | 18:30 | fix(offboarding): resolve the departing account from the ticket, not from form text | 8 | +233/−27 |
| `f6141fc` | 18:31 | fix(offboarding): gate preview and schedule on the request, not just the permission | 2 | +153/−20 |
| `75c3df3` | 18:33 | fix(offboarding): make the drift inversion actually hold | 5 | +85/−10 |
| `ab739d7` | 18:35 | fix(offboarding): stranded runs, duplicate arming, and unpaginated memberships | 4 | +120/−14 |
| `d94e39f` | 18:55 | feat(offboarding): let an armed run be cancelled | 7 | +234/−0 |
| `f11835c` | 19:14 | docs(offboarding): design for phase 2 retention holds | 1 | +142/−0 |
| `ca91f54` | 19:18 | docs(retention): implementation plan for offboarding phase 2 | 1 | +981/−0 |
| `735f61a` | 19:20 | feat(retention): retention_holds table and the review catalog item | 3 | +142/−0 |
| `6145e1c` | 19:21 | feat(retention): classification on any evidence of privilege ever, and the clock | 2 | +171/−0 |
| `98e4398` | 19:22 | feat(retention): record a hold when an offboarding run succeeds | 3 | +233/−0 |
| `c3f9fcf` | 19:23 | feat(retention): the pure sweep decision, including the un-checkable case | 2 | +76/−0 |
| `ae91928` | 19:26 | feat(retention): daily sweep that notices breaches and expiries | 5 | +363/−0 |
| `37d64ec` | 19:26 | Merge offboarding phase 2: retention holds | 0 | +0/−0 |
| `c1f4fef` | 19:43 | feat(scripts): read-only probe for the tenant assumptions we have never verified | 1 | +243/−0 |
| `bec9252` | 19:46 | docs(cmdb): drift-check the June device-sync plan and fix its migration numbers | 1 | +23/−5 |
| `0bcc996` | 19:59 | fix(retention): the feature recorded no hold for the common departure | 9 | +273/−43 |
| `d50d5d2` | 20:01 | fix(retention): sweep robustness and a breach ticket that reaches someone | 2 | +140/−19 |
| `9d83376` | 20:01 | Merge retention-holds review fixes | 0 | +0/−0 |
| `0c6235f` | 21:53 | fix(offboarding): defects introduced by the first round of review fixes | 10 | +229/−12 |
| `7b57f2d` | 21:53 | Merge review fixes for the offboarding fixes (third review) | 0 | +0/−0 |
| `f9df458` | 21:53 | chore: untrack apps/web/OneDeploy, committed by accident | 1 | +0/−0 |

### 2026-09-03 — 40 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `07946a6` | 06:10 | fix(deploy): verify the build that answers, not merely that something answers | 5 | +91/−8 |
| `34be4be` | 06:10 | Merge deploy build-verification | 0 | +0/−0 |
| `bce4682` | 07:09 | fix(auth): suspended users could still sign in and keep live sessions | 3 | +109/−1 |
| `a64ac5a` | 07:09 | Merge: enforce account status in the auth path | 0 | +0/−0 |
| `8614cab` | 07:17 | feat(scripts): stand down seeded demo identities, without deleting them | 3 | +164/−0 |
| `1af5461` | 07:17 | Merge demo-identity stand-down | 0 | +0/−0 |
| `29e1d10` | 07:47 | ci(web): allow deploys from main alongside feat/nexus-platform | 1 | +13/−4 |
| `13a7914` | 07:48 | Merge feat/nexus-platform into main | 0 | +0/−0 |
| `2540aa5` | 07:51 | ci(web): deploy from main only, retiring the transition | 1 | +6/−10 |
| `90d524f` | 08:00 | feat(db): org_integrations, sync-run history, CI provenance columns | 3 | +148/−6 |
| `f98fd87` | 08:04 | feat(authz,config): integration.credentials.manage and Entra sync settings | 5 | +126/−2 |
| `907f496` | 08:46 | feat(entra): envelope encryption and the device->CI mapper | 4 | +275/−0 |
| `d0f96c8` | 08:48 | feat(entra): per-org Graph client factory and managedDevices enumeration | 2 | +129/−0 |
| `d0e061f` | 08:52 | feat(entra): device sync orchestrator with retire-on-complete and run logging | 2 | +258/−0 |
| `5a2c9e8` | 08:56 | feat(entra): admin module — configure, status, test, enable, trigger | 1 | +145/−0 |
| `4ef1caa` | 08:58 | feat(entra): admin + sync routes and the scheduled per-org sync job | 4 | +118/−25 |
| `60d1333` | 09:01 | feat(web): Entra device-sync integration admin page | 4 | +252/−1 |
| `9bc2a29` | 09:09 | fix(entra): ON CONFLICT must repeat the partial index predicate | 2 | +113/−1 |
| `2751334` | 09:11 | docs(env): document INTEGRATION_ENC_KEY and the Entra sync flags | 1 | +11/−0 |
| `e6c3609` | 09:16 | fix(entra): a failed sync says what the tenant said, not "Internal Server Error" | 2 | +13/−1 |
| `7db4a19` | 09:32 | feat(entra): log when the sync scheduler arms, not only when it declines | 1 | +5/−0 |
| `d64e24c` | 09:44 | fix(entra): serialize sync per org, and stop a partial enumeration mass-retiring | 8 | +314/−19 |
| `cebcf3f` | 09:47 | Merge: per-customer Entra/Intune device sync into the CMDB | 0 | +0/−0 |
| `1b71889` | 09:49 | fix(db): create integration.credentials.manage in a migration, not only in seed | 1 | +25/−0 |
| `8577f32` | 11:29 | docs(readme): document the device sync, and ignore Finder conflict copies | 2 | +52/−0 |
| `3dc6d1f` | 11:46 | feat(scripts): create the Anchor-Provisioning app registration, dry-run by default | 1 | +165/−0 |
| `cd98add` | 12:43 | feat(scripts): grant admin consent on a sovereign cloud, where the az shim fails | 1 | +110/−0 |
| `afc0742` | 12:58 | feat(scripts): per-customer device-sync app registration, and a reusable consent path | 2 | +132/−0 |
| `7f571af` | 13:03 | fix(scripts): print an absolute path for the follow-up consent command | 1 | +5/−1 |
| `c34c382` | 13:10 | feat(entra): exclude personal (BYOD) devices from the CMDB | 8 | +127/−9 |
| `c3bdd16` | 13:24 | fix(provisioning,entra): check TAP policy up front; stop the badge claiming a sync that cannot run | 9 | +150/−10 |
| `c9876c0` | 13:38 | fix(provisioning): the Windows 365 licence is conditional, like the Cloud PC itself | 4 | +90/−2 |
| `3dc790f` | 13:48 | fix(entra,provisioning): close the sub-floor collapse gap the BYOD exclusion opened | 6 | +188/−9 |
| `961b1e2` | 14:40 | fix(provisioning): set usageLocation, without which Graph refuses every licence | 6 | +73/−3 |
| `59eab6a` | 15:10 | fix(provisioning): set givenName and surname, not just a display name | 6 | +95/−14 |
| `6220655` | 15:21 | fix(web): stop the catalog dialog discarding a filled form, and pin Send in view | 4 | +265/−142 |
| `91f83e8` | 15:41 | fix(db): clear terminal timestamps left on tickets that moved back to open | 3 | +149/−0 |
| `be37324` | 15:42 | feat(entra): load a customer's Entra staff as Nexus users, without duplicating anyone | 1 | +172/−0 |
| `88dd1c1` | 16:09 | docs(kb): 16 GCC High end-user articles, written for the cloud we actually run | 1 | +386/−0 |
| `138ff16` | 16:49 | fix(entra): match Entra identities globally, and load the SBS roster | 3 | +130/−16 |

### 2026-09-04 — 11 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `41f1a3d` | 09:25 | fix(web): the people picker had no way to close | 3 | +102/−2 |
| `5c30492` | 09:47 | fix(web): portal the people-picker list so a scrolling dialog cannot clip it | 3 | +75/−5 |
| `0e6a55b` | 09:52 | feat(provisioning): make the TAP lifetime configurable, and stop the email guessing it | 5 | +70/−7 |
| `d422166` | 09:55 | fix(kb): stored XSS in search snippets, reachable by any kb.author | 2 | +93/−3 |
| `026d5f0` | 10:07 | feat(web): one Dialog primitive, replacing three copies and a native confirm | 8 | +253/−66 |
| `66201b4` | 10:10 | fix(web): give form controls accessible names, and stop ignoring reduced motion | 5 | +160/−8 |
| `fa6a62c` | 10:12 | fix(web): stop danger red meaning two different things | 5 | +44/−3 |
| `5730227` | 10:18 | fix(web): finish the critique backlog — overlays, focus rings, honest dashboard | 15 | +64/−84 |
| `2f93286` | 10:25 | feat(forms): section long request forms, and fix the order they ask in | 7 | +155/−15 |
| `dee1e5f` | 10:44 | fix(web): stop the status row turning a resolve into a reopen | 4 | +93/−3 |
| `cc8cefd` | 13:03 | fix(scripts): make the user-sync dry run tell the truth about creates | 1 | +12/−1 |

### 2026-09-11 — 18 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `cf2316f` | 09:16 | fix(forms): unblock the onboarding request — live-sourced selects, findable people, locatable errors | 13 | +187/−14 |
| `b5953de` | 09:35 | fix(web): an optional dropdown you cannot clear is a mandatory one | 3 | +56/−2 |
| `a1c40ec` | 09:47 | fix(accounts): actually make provider staff findable — RLS was filtering them out | 2 | +44/−16 |
| `ca1a134` | 10:13 | fix(web): say when a typed name is not a selection, and retract errors once fixed | 6 | +86/−6 |
| `1ec8eb7` | 10:38 | fix(posture): answer the cross-customer dashboard; feat(provisioning): .ctr UPNs for contractors | 5 | +165/−8 |
| `1a2965d` | 10:50 | feat(provisioning): make "copy access from" actually copy access — carefully | 5 | +227/−3 |
| `a3ab09d` | 11:04 | fix(web): lift the people picker's results above the dialog backdrop | 4 | +52/−2 |
| `c20e12d` | 11:26 | fix(provisioning): stop throwing away the reason a TAP request failed | 7 | +208/−2 |
| `bacfeab` | 11:32 | fix(scripts): derive the consent count instead of hardcoding "five" | 1 | +2/−2 |
| `274f9b7` | 11:47 | feat(provisioning): put the rest of the intake on the directory record | 10 | +389/−14 |
| `f6c9f97` | 11:54 | feat(forms): choose security groups from the tenant instead of typing them | 16 | +435/−6 |
| `7021b64` | 12:22 | fix(provisioning): make the first sign-in actually work | 9 | +225/−10 |
| `fb2b8e9` | 12:29 | feat(provisioning): offer a temporary password as the first credential | 9 | +251/−24 |
| `87cb4f6` | 12:40 | fix(provisioning): repair accounts left demanding an impossible password change | 3 | +75/−4 |
| `f5e0fa9` | 12:47 | fix(provisioning): stop asking Graph for a property it refuses to return | 4 | +32/−15 |
| `fd90e48` | 12:54 | fix(provisioning): never let a best-effort repair fail the whole run | 2 | +88/−23 |
| `310c35b` | 13:53 | feat(csat): three-question survey answerable from the email, without signing in | 12 | +812/−26 |
| `af01b34` | 14:01 | fix(web): unwrap the survey page params, which Next 15 hands over as a promise | 2 | +6/−3 |

### 2026-09-24 — 4 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `217ea5e` | 13:03 | fix(admin): repair platform user administration and staff sign-in for roster-synced staff | 6 | +564/−101 |
| `2a8f11b` | 13:03 | fix(provisioning): stop distribution lists failing onboarding and skipping Cloud PC/TAP | 7 | +292/−36 |
| `cd288d5` | 13:03 | feat(tickets): show staff the full submitted request form on a ticket | 11 | +867/−3 |
| `3b0b4b3` | 13:19 | fix(security): stop a customer admin from granting itself platform SuperAdmin | 4 | +106/−3 |

### 2026-09-30 — 9 commits

| Commit | Time | Message | Files | +/− |
|---|---|---|---|---|
| `2448d74` | 08:53 | fix(provisioning): copy IT on credential emails; stop mirrored admin groups blocking onboarding | 10 | +134/−15 |
| `7bc4e0b` | 09:03 | feat(provisioning): send the SBS Microsoft 365 onboarding guide with the new user's credential | 4 | +478/−28 |
| `05d05f3` | 09:05 | fix(provisioning): declare UTF-8 in the onboarding guide so checkboxes and dashes render | 2 | +9/−1 |
| `ca87d3d` | 09:10 | fix(provisioning): make temporary-password mode work; drop distribution lists from onboarding | 7 | +102/−13 |
| `4d507b7` | 09:12 | feat(provisioning): resend the onboarding email with a new temporary password | 5 | +230/−3 |
| `d39dd55` | 09:29 | feat(tickets): let admins correct the answers on a submitted request | 13 | +1512/−43 |
| `f28d914` | 09:36 | fix(web): stop one ticket card from crashing the whole ticket page | 3 | +53/−15 |
| `585b738` | 09:38 | fix(web): keep the Submitted form's pii reference null-safe after the sections guard | 1 | +1/−1 |
| `3d1041c` | 09:49 | fix(web): allow resending onboarding credentials while a run awaits its Cloud PC | 1 | +3/−1 |
