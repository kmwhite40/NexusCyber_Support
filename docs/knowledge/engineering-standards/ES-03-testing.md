# ES-03 — Testing Standards

| | |
|---|---|
| **Applies to** | `apps/api/test`, `apps/web/test` |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Tooling

| Layer | Tool | Location |
|---|---|---|
| API unit | Vitest | `apps/api/test/*.test.ts` |
| API integration (real Postgres) | Vitest | `apps/api/test/integration/*.int.test.ts` |
| Web components | Vitest + Testing Library + jsdom | `apps/web/test/*.test.tsx` |
| Load | scripts in `load/` | run manually before major releases |
| Post-deploy smoke | `scripts/smoke.sh` | run after every deploy |

## 2. What must be tested

- **Every bug fix ships with a test that fails without the fix.** Name the test after the behaviour, not the ticket.
- **Authorization:** any new permission verb or PDP rule needs allow *and* deny cases in `pdp.test.ts` or the module's test.
- **Tenant isolation:** any new table holding org data needs an integration test proving another org cannot read it (see `posture-cross-org.test.ts`).
- **Planners** (provisioning, offboarding, retention) are pure — test them exhaustively with fixtures, no network.
- **Graph adapters** are tested against recorded or fixture responses, including the sovereign-cloud differences (for example Cloud PC `status` only on beta in GCC High).
- **Security-sensitive rendering** (KB snippets, notification bodies) needs an XSS/escaping test (see `kb-snippet-xss.test.ts`).

## 3. Integration tests and the database trap

Integration tests **skip silently** when `DATABASE_URL` is unset — and the suite still reports green. The dev database runs on host port **5544**, not 5432.

```bash
set -a; . ./.env; set +a
npm --workspace apps/api run migrate
npm --workspace apps/api run test
```

If the integration count in the output is zero, the tests did not run. CI provides its own Postgres 16 service and runs migrate + seed first, so integration suites always execute there.

## 4. Conventions

- Tests are deterministic: inject clocks and IDs; never depend on wall-clock time or ordering of `Set`/`Map` iteration.
- Shared fixtures live in `apps/api/test/fixtures/`, helpers in `apps/api/test/helpers/`.
- Web tests query by role and accessible name (Testing Library's defaults). If an element cannot be found by role, fix the markup's accessibility first.
- Do not mock the module under test. Mock at the integration boundary (Graph client, mail transport).

## 5. CI gate

A change is not mergeable unless the **Typecheck · Test · Build** job is green. That job runs typecheck → migrate & seed → API tests → web tests → build.
