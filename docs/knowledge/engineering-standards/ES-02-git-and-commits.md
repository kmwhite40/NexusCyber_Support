# ES-02 — Git, Branching & Commit Standards

| | |
|---|---|
| **Applies to** | `kmwhite40/NexusCyber_Support` |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Branches

| Branch | Purpose |
|---|---|
| `main` | Always deployable. What is on `main` is what production runs, or is about to. |
| `feat/<topic>` | Feature work. CI runs on every push to `feat/**`. |
| `hotfix/<topic>` | Urgent production fixes. Branch from `main`, merge back quickly, delete afterwards. |

- Large, multi-week bodies of work go through a **pull request** (as PR #1 and PR #2 did).
- Small, verified fixes may be pushed directly to `main` **only after typecheck and tests pass locally**.
- Delete branches once merged. A branch whose patches are already on `main` (check with `git cherry -v main <branch>`) should not linger.

## 2. Commit messages — Conventional Commits

```
<type>(<scope>): <imperative summary, lower case, no full stop>

<body: what changed and WHY — the constraint, incident or defect that forced it>
```

**Types in use:** `feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `ops`, `infra`.

**Scopes** name the capability, matching the module name where possible:
`web`, `tickets`, `provisioning`, `offboarding`, `m365`, `entra`, `forms`, `changes`, `cab`, `kb`, `sla`, `db`, `retention`, `dashboards`, `deploy`, `mail`, `scripts`.

**Good:**
```
fix(tickets): serialize ticket-number allocation on all three create paths
fix(web): stop one ticket card from crashing the whole ticket page
```

**Avoid:** `fix stuff`, `WIP`, `updates`, or summaries that describe the diff instead of the behaviour.

## 3. Commit hygiene

- One logical change per commit. A migration and the code that depends on it belong in the same commit.
- The summary describes the **user-visible behaviour** ("stop one ticket card from crashing…"), not the mechanism.
- Never commit secrets, `.env` files, `infra/azure/.secrets.*`, or database dumps from `backups/`.
- AI-assisted commits carry the agreed `Co-Authored-By` trailer.

## 4. Before you push

```bash
npm run typecheck
npm run test
```

Source the root `.env` first, or the DB-backed integration tests skip silently and the run still looks green (see [ES-03](ES-03-testing.md)).
