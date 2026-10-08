# ADR-0008 — Digest-pinned API deploys verified by build SHA

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06 (verification step tightened 2026-09) |
| **Related** | ES-07; `scripts/deploy-api.sh`, `/healthz` build info |

## Context
Two failure modes were observed: `az webapp restart` kept serving a cached `:latest` image, and a deploy reported success while the **old** container was still answering — a crash-looping new container (for example a failed boot migration) would have looked identical.

## Decision
- Build in ACR tagged with the **git short SHA** (`BUILD_SHA` baked into the image).
- Pin the App Service to the **immutable image digest**, never a mutable tag.
- After restart, poll `/healthz` until it reports **the SHA just built**. Only then is the deploy successful.
- Basic-auth publishing is disabled by policy; deploys use the operator's Entra session.

## Consequences
**Positive:** every deploy is traceable to a commit; rollback is re-pinning a previous digest.
**Negative:** deploys take longer (wait for the new container to warm).
