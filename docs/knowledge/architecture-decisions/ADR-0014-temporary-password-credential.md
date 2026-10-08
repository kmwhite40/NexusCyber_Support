# ADR-0014 — Deliver a temporary password (not a TAP) for new accounts

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-30 |
| **Related** | ADR-0010; commits `4d507b7`, `3d1041c` |

## Context
Provisioning originally issued an Entra **Temporary Access Pass**. In GCC High, TAP issuance returned Graph 404 for new users, and adopted accounts kept `forceChangePasswordNextSignIn`, which a TAP cannot satisfy — new hires could not sign in.

## Decision
- `M365_PROV_INITIAL_CREDENTIAL=password`: new accounts are **created with** a generated temporary password (forced change at first sign-in).
- The password is delivered in the SBS onboarding-guide email, CC'd to IT and HR by SBS decision.
- Operators can **resend** onboarding credentials from the ticket, which resets the password (requires `User-PasswordProfile.ReadWrite.All`, consented 2026-09-30).

## Consequences
**Positive:** first sign-in works reliably in GCC High.
**Negative:** a live password is sent by email and visible to the CC recipients until changed — an accepted business risk. TAP remains available via config if GCC High support matures.
