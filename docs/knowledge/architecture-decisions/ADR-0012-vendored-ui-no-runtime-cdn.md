# ADR-0012 — Vendored UI components; no runtime third-party fetches

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec §V.2; ES-08 |

## Context
Government enclaves restrict egress, and runtime fetches from public CDNs are both a supply-chain and a data-boundary risk.

## Decision
Components from 21st.dev / shadcn are **copied into** `apps/web/components/ui/` and governed as first-party code. Fonts, images and icons are bundled locally. The browser talks only to Anchor's own origins.

## Consequences
**Positive:** reproducible builds, gov-egress safe, full control over accessibility fixes.
**Negative:** upstream improvements are not automatic — upgrades are deliberate copies.
