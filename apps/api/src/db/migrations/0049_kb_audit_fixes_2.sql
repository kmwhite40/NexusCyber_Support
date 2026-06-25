-- KB audit fixes, round 2 — content gaps surfaced in editorial review.
--
-- Fixes (each updates an article seeded with NULL organization_id):
--  1. Data classification — listed the four levels but defined none. Define each.
--  2. Password & MFA policy — never stated the minimum length. State 14 characters.
--  3. JIT elevation — said it "expires automatically" but never how long. State 60 min.
--  4. "Trusted device" was used undefined in two articles (lost device + MFA reset). Define inline.
--  5. "How to submit a great ticket" — never said WHERE to submit. Add the portal/mailbox/hotline.
--  6. "Set up email & calendar on your phone" — title promised calendar; body covered only email.
--  7. Two cross-references were plain text / bare [brackets]. Make them real links via the
--     /kb?q=<text> deep-link (article IDs are not stable across environments).
-- Idempotent (UPDATE-by-title).

-- 1) Data classification: define the four levels.
UPDATE kb_pages SET body = $md$# Classify and retain correctly

Apply the sensitivity label that matches the impact if the data were disclosed. The four levels are:

- **Public** — cleared for release outside the organization; no harm if disclosed (e.g., published marketing, public-facing docs).
- **Internal** — for everyday business use inside the org; not for public release but low impact if leaked (e.g., internal memos, org charts, project notes).
- **Confidential** — sensitive business data that would cause real harm if disclosed; share only with named people who need it (e.g., contracts, financials, customer lists).
- **CUI** — Controlled Unclassified Information governed by federal rules; handled under NIST 800-171 with encryption, DLP, and restricted sharing (e.g., FCI/CUI received under a government contract).

Retention is applied by label and record type. Do not delete records under legal hold; eDiscovery and holds are managed by the security team.$md$
 WHERE organization_id IS NULL AND title = 'Data classification & retention';

-- 2) Password policy: state the 14-character minimum.
UPDATE kb_pages SET body = $md$# Password & MFA policy

- Passwords must be **at least 14 characters**; complexity is enforced and **passphrases are encouraged** (a longer phrase beats a short, complex string).
- **MFA is mandatory** under Conditional Access; Authenticator is preferred.
- Never reuse work passwords elsewhere or share them. Report suspected compromise immediately.$md$
 WHERE organization_id IS NULL AND title = 'Password & MFA policy';

-- 3) JIT elevation: state the 60-minute default duration.
UPDATE kb_pages SET body = $md$# Privileged access is time-boxed

Standing admin rights are minimized. To perform privileged work:

1. **Request elevation** for the specific permissions and reason at **https://anchor.azurewebsites.us**.
2. A different approver grants it (separation of duties). Elevation is **time-boxed to 60 minutes** by default and **expires automatically** — request again if you need more time.
3. **Break-glass** exists for emergencies — it is immediate but loud: it pages on-call and raises a critical audit event that is reviewed.

Questions about privileged access? Email **anchor-support@sbsfederal.com**, or call the **NexusCyber Hotline — (800) 265-6446** for an after-hours emergency.$md$
 WHERE organization_id IS NULL AND title = 'Just-in-time elevation & break-glass';

-- 4a) Lost or stolen device: define "trusted device".
UPDATE kb_pages SET body = $md$# Lost or stolen device

Act fast to protect data.

1. Open a **Lost / stolen device — wipe & revoke** request at **https://anchor.azurewebsites.us** immediately (P1). After hours, call the **NexusCyber Hotline — (800) 265-6446**.
2. We revoke sessions, disable sign-in, and remote-wipe the device.
3. Re-enroll MFA at **https://mysignins.microsoft.us** and change your password at **https://passwordreset.microsoftonline.us** from a **trusted device** — a managed, company-enrolled device that meets our compliance policy (not a public, kiosk, or personal computer).

Report even if you think it may turn up — we can reverse a selective wipe more easily than a breach.$md$
 WHERE organization_id IS NULL AND title = 'Lost or stolen device';

-- 4b) MFA reset: define "trusted device".
UPDATE kb_pages SET body = $md$# Lost the phone with your Authenticator?

Your MFA methods are tied to your account, not just one device.

## If you can still sign in

1. Go to **Security info** (`mysignins.microsoft.us` in GCC High, `mysignins.microsoft.com` commercial).
2. **Add** the Authenticator on your new phone first.
3. **Delete** the old/lost device entry so it can no longer approve sign-ins.

## If you are locked out (no working method)

1. Submit a **MFA reset** request from the Service catalog.
2. We verify your identity out-of-band (manager confirmation or a recorded line), then clear your methods.
3. You will be prompted to re-register MFA at next sign-in — do this from a **trusted device** (a managed, company-enrolled device that meets our compliance policy — not a public or personal computer) within the time window.

Report a *stolen* phone as a security incident as well, so sessions are revoked.$md$
 WHERE organization_id IS NULL AND title = 'Reset your MFA / lost authenticator phone';

-- 5) "How to submit a great ticket": say where to submit + link the SLA cross-reference.
UPDATE kb_pages SET body = $md$# Help us help you

**Where to submit:** open a ticket in the support portal at **https://anchor.azurewebsites.us** (choose **+ New ticket**, or ask **Ask Anchor**). You can also email **anchor-support@sbsfederal.com** — that opens a ticket automatically. For a P1 after hours, call the **NexusCyber Hotline — (800) 265-6446**.

A good ticket is resolved faster. Include:

- **What** happened and the exact error text or a screenshot.
- **When** it started and whether it is constant or intermittent.
- **Who** is affected (just you, your team, everyone?).
- **Impact** — can you work, or are you blocked?

We set priority from **impact × urgency** — see [Ticket priorities & SLAs explained](https://anchor.azurewebsites.us/kb?q=Ticket%20priorities%20%26%20SLAs).$md$
 WHERE organization_id IS NULL AND title = 'How to submit a great ticket';

-- 6) Phone setup: add calendar coverage (+ a 'calendar' label).
UPDATE kb_pages SET body = $md$# Email & calendar on mobile

Use the **Outlook** app for both mail and calendar (required for compliance — it keeps work data in a protected container).

1. Install **Microsoft Outlook** from your app store.
2. Add your work account and approve the MFA prompt.
3. If asked, enroll the device or accept the app-protection policy.

## Calendar

Your calendar is built into the same Outlook app — no separate setup. Tap the **Calendar** icon at the bottom of Outlook to view your schedule, accept invites, and create events; it syncs with the calendar on your computer. For Teams meeting links and join, also install the **Teams** app and sign in with your work account.

Native mail and calendar apps are not supported for work accounts.$md$,
       labels = (SELECT array_agg(DISTINCT l) FROM unnest(labels || ARRAY['calendar']) AS l)
 WHERE organization_id IS NULL AND title = 'Set up email & calendar on your phone';

-- 7) GCC High SSPR: turn the bare [bracket] cross-reference into a real link.
UPDATE kb_pages SET body = $md$# Reset your own password — GCC High

GCC High (and DoD) tenants use the US Government cloud endpoints (`*.us`), **not** the commercial `.com` portals. Self-service password reset (SSPR) lets you reset or unlock your account without calling the Service Desk — *provided you have registered your authentication methods first*.

## Before you are locked out — register (one time)

1. Go to **https://aka.ms/ssprsetup** (it redirects to the Government **My Sign-ins → Security info** page, `mysignins.microsoft.us`).
2. Sign in and add at least **two** methods, e.g. the **Microsoft Authenticator** app (preferred) plus a **mobile phone** number.
3. Approve the test prompt to confirm each method works.

## Reset your password

1. From the GCC High sign-in screen, choose **Can't access your account?** → **Work or school account**, or go directly to **https://passwordreset.microsoftonline.us**.
2. Enter your work email and the on-screen characters.
3. Choose a verification method you registered (Authenticator approval, code by text/call).
4. Set a new password that meets the complexity policy (do not reuse a recent one).
5. Sign in everywhere again — mail, VPN, and Wi-Fi may each re-prompt.

> **Note:** the commercial `passwordreset.microsoftonline.com` page will **not** work for a GCC High account — always use the `.us` address.

## If SSPR will not let you in

- You may not have registered methods, or your only method (e.g., a lost phone) is unavailable.
- Submit an **Account unlock / password reset** request from the Service catalog; we will verify your identity out-of-band before resetting. See also [Reset your MFA / lost authenticator phone](https://anchor.azurewebsites.us/kb?q=Reset%20your%20MFA%20lost%20authenticator).$md$
 WHERE organization_id IS NULL AND title = 'Self-service password reset in GCC High';
