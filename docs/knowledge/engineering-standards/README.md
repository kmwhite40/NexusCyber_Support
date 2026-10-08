# Engineering Standards — Anchor

Standards every change to Anchor (`kmwhite40/NexusCyber_Support`) is expected to meet. They codify how the platform is already built and the lessons from production incidents. If a standard is wrong, change it via a PR — don't silently ignore it.

| ID | Standard | Covers |
|---|---|---|
| [ES-01](ES-01-code-and-typescript.md) | Code & TypeScript | Layout, style, errors, logging, dependencies |
| [ES-02](ES-02-git-and-commits.md) | Git & commits | Branches, Conventional Commits, pre-push checks |
| [ES-03](ES-03-testing.md) | Testing | What must be tested, the silent-skip DB trap, CI gate |
| [ES-04](ES-04-database-and-migrations.md) | Database & migrations | Owner vs app role, RLS, forward-only migrations, seed dual-write |
| [ES-05](ES-05-security-and-tenant-isolation.md) | Security & tenant isolation | Identity, PDP, PII, secrets, audit, supply chain |
| [ES-06](ES-06-integrations-and-feature-flags.md) | M365/Graph & feature flags | Kill switches, sovereign clouds, planner/executor |
| [ES-07](ES-07-deployment-and-release.md) | Deployment & release | Azure Gov topology, deploy scripts, rollback |
| [ES-08](ES-08-frontend-and-ui.md) | Frontend & UI | Vendored components, accessibility, resilience |

## Definition of done (summary)
- [ ] Typecheck and tests pass with the `.env` loaded (integration tests actually ran)
- [ ] New tenant tables have RLS + a cross-org test
- [ ] New permissions granted by migration and covered by PDP tests
- [ ] Seeded-content changes dual-written to `seed.ts` and a migration
- [ ] New tenant-touching capability is behind an off-by-default flag
- [ ] Conventional Commit message explaining *why*
- [ ] Deployed with the scripts; `/healthz` shows the new SHA; smoke test passed
