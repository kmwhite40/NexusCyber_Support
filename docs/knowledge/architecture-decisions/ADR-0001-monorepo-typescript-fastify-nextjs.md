# ADR-0001 — TypeScript monorepo: Fastify API + Next.js web

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec §V (stack), ES-01 |

## Context
Anchor needed a working vertical slice quickly (ticketing, SLA, posture, audit, RLS) with one small team, and a code base that could be operated inside Azure Government.

## Decision
A single npm-workspaces monorepo with two apps:
- `apps/api` — Node.js + **Fastify** + `node-postgres` (no ORM), TypeScript strict, ES modules, zod validation, pino logging.
- `apps/web` — **Next.js (App Router)** + Tailwind, deployed as a standalone bundle.
Shared conventions, one CI pipeline, one version history.

## Alternatives considered
| Option | Why not |
|---|---|
| ORM (Prisma/TypeORM) | RLS needs exact control over transaction-local `set_config`; raw SQL keeps that visible. |
| Separate repos | Cross-cutting changes (API + UI + migration) would span PRs. |
| .NET | Team velocity was higher in TypeScript; one language front and back. |

## Consequences
**Positive:** one language, atomic cross-stack commits, fast iteration (407 commits in 13 working days).
**Negative:** SQL is hand-written — needs tests and review discipline (ES-04).
**Follow-up:** the Fastify 5 upgrade is complete; keep framework majors current.
