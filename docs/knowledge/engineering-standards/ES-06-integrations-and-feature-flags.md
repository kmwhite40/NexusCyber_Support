# ES-06 — Microsoft 365 / Graph Integrations & Feature Flags

| | |
|---|---|
| **Applies to** | `apps/api/src/integrations/**`, `modules/provisioning`, `modules/offboarding`, `jobs/*` |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Every integration is behind a kill switch

Integrations that touch a real tenant are **off unless explicitly enabled** by an environment variable on `anchor-api`:

| Flag | Controls |
|---|---|
| `M365_ENABLED` | Graph mail notifications |
| `M365_INGEST_ENABLED` | Inbound mail → ticket |
| `M365_TEAMS_ENABLED` | Teams posts |
| `M365_PROV_ENABLED` | Onboarding provisioning (accounts, licences, groups, Cloud PC) |
| `M365_OFFBOARD_ENABLED` | Offboarding teardown (ANDed with `M365_PROV_ENABLED`) |
| `ENTRA_SYNC_ENABLED` | Scheduled Entra/Intune device sync |
| `OIDC_ENABLED` / `OIDC_CUSTOMER_ENABLED` | Agent / customer SSO |
| `RETENTION_PURGE_ENABLED` | Destructive retention purge |
| `SELF_SIGNUP_ENABLED` | Customer self-registration |

- New integrations add a flag, default **false**, and document it in the module README.
- The first production run of any destructive capability (offboarding, purge) is a **supervised** run.

## 2. All Graph calls go through the integration layer

- No `fetch('https://graph...')` outside `integrations/`. The layer owns endpoints per cloud, token acquisition, throttling/retry and error mapping.
- **Sovereign clouds differ.** GCC High uses `graph.microsoft.us`; some resources are only complete on **beta** (Cloud PC `status`). Pin API versions through config (e.g. `M365_PROV_CLOUDPC_API_VERSION`), never as code literals, so a tenant difference is a config flip.
- Probe before you assume: `scripts/probe-provisioning-tenant.sh` and `scripts/probe-tenant-followups.sh` are **read-only** and answer "does this tenant support X".

## 3. Planner / executor pattern for tenant changes

Anything that mutates a tenant follows the provisioning model:

1. A **pure planner** turns the request into an ordered list of steps.
2. The UI shows a **dry-run preview** of that plan.
3. A **resumable executor** runs the steps, recording each step's outcome so a failed run resumes from the failed step instead of repeating completed ones.
4. Execution is bound to the previewed plan by a **fingerprint**; if state changed, the API returns *precondition failed* and the operator re-previews.

Step order is a correctness rule, not a preference — offboarding converts the mailbox to shared **before** removing licences, or the mailbox is lost.

## 4. Inbound integrations

- External systems use M2M **API keys** (ES-05) and an **`external_ref`** for idempotent ticket upsert — replaying the same item never creates a duplicate.
- Outbound status write-back uses **HMAC-signed webhooks** (`modules/webhooks.ts`). Receivers must verify the signature.
- Mutating endpoints accept an **`Idempotency-Key`** header.

## 5. Operational scripts

Scripts under `apps/api/src/scripts/` that change data are **dry-run by default** and require an explicit flag to write. They print what they would change before changing it.
