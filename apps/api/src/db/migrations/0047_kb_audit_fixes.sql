-- KB audit fixes + gap-fill.
--
-- ERRORS fixed:
--  1. Duplicate MFA-setup article across two spaces — remove the Help Desk duplicate,
--     keep the (now enriched) Security one.
--  2. Security articles missing URLs / contact info — add concrete endpoints + the
--     support portal, support mailbox, and after-hours hotline.
--  3. Tag hygiene — 'govcloud' was on Azure / M365 articles (it should denote AWS GovCloud
--     only, which pollutes search). Retag: Azure Government -> 'azure-gov';
--     M365 GovCloud (Help Desk) -> 'gcc-high'. AWS GovCloud articles keep 'govcloud'.
--
-- GAPS filled: FAQ space, a Known Issues log, and additional onboarding content.
-- Idempotent.

-- 1) Remove the duplicate MFA-setup article from the Help Desk space.
DELETE FROM kb_pages
 WHERE organization_id IS NULL
   AND title = 'Set up MFA with Microsoft Authenticator (GovCloud)'
   AND space_id IN (SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk');

-- 2) Enrich Security (SEC) articles with real URLs + contact info.
UPDATE kb_pages SET body = $md$# Set up MFA

MFA protects your account even if your password is stolen.

1. Go to **My Sign-ins → Security info**: **https://mysignins.microsoft.us** (GovCloud) — or start at **https://aka.ms/ssprsetup**.
2. Choose **Add sign-in method → Microsoft Authenticator** (preferred over SMS) and follow the prompts on your phone.
3. Add a **second method** (a mobile phone for text/call) as a backup, then approve the test prompt.

MFA is required for all accounts under the Conditional Access baseline.

**Need help?** Open a request at https://anchor.azurewebsites.us or email anchor-support@sbsfederal.com. Locked out after hours? Call the **NexusCyber Hotline — (800) 265-6446**.$md$
 WHERE organization_id IS NULL AND title = 'Set up multi-factor authentication (MFA)';

UPDATE kb_pages SET body = $md$# Spotted a suspicious email?

**Do not click links or open attachments.**

1. Use the **Report → Report phishing** button in Outlook. If it is not available, forward the message **as an attachment** to **anchor-support@sbsfederal.com**.
2. Delete the message after reporting.
3. If you already clicked a link or entered credentials, **change your password now** at **https://passwordreset.microsoftonline.us** and open a **Report a security incident** request at **https://anchor.azurewebsites.us**.

We analyze it, purge it from other mailboxes, and block the sender. Suspect an active compromise after hours? Call the **NexusCyber Hotline — (800) 265-6446**.$md$
 WHERE organization_id IS NULL AND title = 'Report a phishing email';

UPDATE kb_pages SET body = $md$# Lost or stolen device

Act fast to protect data.

1. Open a **Lost / stolen device — wipe & revoke** request at **https://anchor.azurewebsites.us** immediately (P1). After hours, call the **NexusCyber Hotline — (800) 265-6446**.
2. We revoke sessions, disable sign-in, and remote-wipe the device.
3. Re-enroll MFA at **https://mysignins.microsoft.us** and change your password at **https://passwordreset.microsoftonline.us** from a trusted device.

Report even if you think it may turn up — we can reverse a selective wipe more easily than a breach.$md$
 WHERE organization_id IS NULL AND title = 'Lost or stolen device';

UPDATE kb_pages SET body = $md$# Privileged access is time-boxed

Standing admin rights are minimized. To perform privileged work:

1. **Request elevation** for the specific permissions and reason at **https://anchor.azurewebsites.us**.
2. A different approver grants it (separation of duties); it expires automatically.
3. **Break-glass** exists for emergencies — it is immediate but loud: it pages on-call and raises a critical audit event that is reviewed.

Questions about privileged access? Email **anchor-support@sbsfederal.com**, or call the **NexusCyber Hotline — (800) 265-6446** for an after-hours emergency.$md$
 WHERE organization_id IS NULL AND title = 'Just-in-time elevation & break-glass';

UPDATE kb_pages SET body = $md$# CUI handling basics

- Store CUI only in **approved, labeled** workspaces (request a **CUI workspace** at **https://anchor.azurewebsites.us**).
- Apply the correct **sensitivity label**; labels drive encryption and DLP.
- Do not email CUI externally or to personal accounts; sharing is restricted by policy.
- Report suspected spillage **immediately** as a security incident at **https://anchor.azurewebsites.us** — after hours, call the **NexusCyber Hotline — (800) 265-6446**. Questions: **anchor-support@sbsfederal.com**.$md$
 WHERE organization_id IS NULL AND title = 'Handling Controlled Unclassified Information (CUI)';

-- 3) Tag hygiene.
-- Azure Government article was mistagged 'govcloud' (that term denotes AWS GovCloud).
UPDATE kb_pages SET labels = array_replace(labels, 'govcloud', 'azure-gov')
 WHERE organization_id IS NULL AND 'govcloud' = ANY(labels)
   AND title = 'Sign in to Azure Government (portal & CLI)';
-- Help Desk M365 GovCloud articles -> 'gcc-high' (AWS GovCloud articles, in the CLOUD space, keep 'govcloud').
UPDATE kb_pages SET labels = array_replace(labels, 'govcloud', 'gcc-high')
 WHERE organization_id IS NULL AND 'govcloud' = ANY(labels)
   AND space_id IN (SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk');

-- 4) GAP: FAQ space + FAQ articles.
DO $$
DECLARE sp uuid;
BEGIN
  SELECT id INTO sp FROM kb_spaces WHERE organization_id IS NULL AND key = 'FAQ';
  IF sp IS NULL THEN
    INSERT INTO kb_spaces (organization_id, key, name, description)
      VALUES (NULL, 'FAQ', 'FAQs', 'Frequently asked questions, answered quickly') RETURNING id INTO sp;
  END IF;

  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('FAQ: Accounts & sign-in',
     $md$# FAQ — Accounts & sign-in

**How do I reset my password?**
Use **https://passwordreset.microsoftonline.us** (GovCloud). If you have not registered MFA methods, file an *Account unlock / password reset* request.

**I'm locked out — what now?**
Wait a few minutes, then reset your password. Still locked out? File an *Account unlock* request, or after hours call the **NexusCyber Hotline — (800) 265-6446** for a P1.

**I got a new phone — how do I move my Authenticator?**
At **https://mysignins.microsoft.us**, add Authenticator on the new phone first, then remove the old device. See *Reset your MFA / lost authenticator phone*.

**My password "expired."**
Choose **Update password** at sign-in, or reset at the link above, then sign in again everywhere.

**Where do I file a request?**
The support portal: **https://anchor.azurewebsites.us**.$md$,
     ARRAY['faq','accounts','password','mfa']),

    ('FAQ: Devices & software',
     $md$# FAQ — Devices & software

**How do I get my device managed (Intune)?**
Search for **"Company Portal"** in your app store, install it, sign in, and enroll. See *Enroll your device with Intune*.

**How do I install an app?**
Open **Company Portal** and choose **Install**. If it is not listed, file a *Software installation* request.

**It is asking for a BitLocker recovery key.**
Retrieve it from **https://myaccount.microsoft.us → Devices**, or file a *BitLocker recovery key retrieval* request.

**My computer is slow / something is broken.**
See the troubleshooting guides (slow PC, Wi-Fi, printer, Outlook, Teams, OneDrive). Still stuck? File a ticket at **https://anchor.azurewebsites.us**.

**Which email app should I use?**
Desktop: **Outlook (Classic)** (GovCloud requirement). Mobile: the **Outlook** app.$md$,
     ARRAY['faq','devices','software','intune']),

    ('FAQ: Email & collaboration',
     $md$# FAQ — Email & collaboration

**Outlook says "new Outlook" — is that OK?**
No. In GovCloud use **Outlook (Classic)**; turn the **New Outlook** toggle **off**.

**How do I get a shared mailbox or distribution list?**
File a *Shared mailbox & distribution list* request with the name, owner, and members.

**How do I set an out-of-office?**
Outlook → **File → Automatic Replies**, or on the web **Settings → Mail → Automatic replies**.

**Can I auto-forward work mail to a personal account?**
No — external auto-forwarding is blocked by policy in government tenants.

**How do I recover a deleted file?**
Use the OneDrive/SharePoint **Recycle bin** (within 93 days) or **Version history**; otherwise file a *File / site restore* request.$md$,
     ARRAY['faq','email','outlook','collaboration'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (SELECT 1 FROM kb_pages p WHERE p.space_id = sp AND p.organization_id IS NULL AND p.title = v.title);
END $$;

-- 5) GAP: Known Issues log.
DO $$
DECLARE sp uuid;
BEGIN
  SELECT id INTO sp FROM kb_spaces WHERE organization_id IS NULL AND key = 'KI';
  IF sp IS NULL THEN
    INSERT INTO kb_spaces (organization_id, key, name, description)
      VALUES (NULL, 'KI', 'Known Issues', 'Current known issues, status, and workarounds') RETURNING id INTO sp;
  END IF;

  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('Known issues log',
     $md$# Known issues log

This page lists current, confirmed issues so you do not have to file a duplicate ticket. The help desk updates it as issues are opened and resolved. If your problem is **not** listed, file a ticket at **https://anchor.azurewebsites.us**.

| Opened | Issue | Who's affected | Status | Workaround |
| --- | --- | --- | --- | --- |
| — | _No active known issues at this time._ | — | — | — |

## How this works
- **Investigating** — we have confirmed the issue and are working it.
- **Workaround available** — use the listed workaround until the fix ships.
- **Resolved** — fixed; the row is removed after a short grace period.

For a major outage, watch for a portal **announcement** banner and check this page first. P1 after hours: **NexusCyber Hotline — (800) 265-6446**.$md$,
     ARRAY['known-issues','status','outage'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (SELECT 1 FROM kb_pages p WHERE p.space_id = sp AND p.organization_id IS NULL AND p.title = v.title);
END $$;

-- 6) GAP: additional onboarding content (Help Desk space).
DO $$
DECLARE sp uuid;
BEGIN
  SELECT id INTO sp FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk';
  IF sp IS NULL THEN
    INSERT INTO kb_spaces (organization_id, key, name, description)
      VALUES (NULL, 'helpdesk', 'Help Desk', 'Self-service answers for the most common IT requests') RETURNING id INTO sp;
  END IF;

  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('Onboarding: equipment and account setup',
     $md$# Onboarding: equipment and account setup

Welcome aboard. Here is how your equipment and accounts come together in your first days.

## Accounts
1. **Sign in** to your work account and set your password.
2. **Register MFA** (Authenticator + a backup phone) at **https://mysignins.microsoft.us**.

## Your device
3. **Enroll** the device with **Company Portal** so it becomes compliant.
4. **Install** the apps you need from Company Portal.

## Email & access
5. Set up **Outlook (Classic)** on desktop and the **Outlook** app on mobile.
6. Connect to **Wi-Fi / VPN** as needed.
7. Request any role/app access you need from the **Service catalog**.

Stuck on any step? Use **Ask Anchor** on the portal or file a request at **https://anchor.azurewebsites.us**.$md$,
     ARRAY['onboarding','getting started','new hire']),

    ('Manager checklist: onboard a new team member',
     $md$# Manager checklist: onboard a new team member

Start these **before** the new hire's first day so they are productive on day one.

1. File a **New user creation & provisioning** request with the person's name, role/title, manager, and start date.
2. Specify the **groups, licenses, and app access** they need (mirror a peer if helpful).
3. Request **equipment** (laptop, peripherals) via the catalog if not already assigned.
4. For privileged or CUI access, note the **justification** — approvals may be required.
5. On day one, point them to **Onboarding: equipment and account setup** and the **FAQs**.

Offboarding later? File a **Deprovisioning & offboarding** request on or before the last day so access is revoked on time.$md$,
     ARRAY['onboarding','manager','provisioning'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (SELECT 1 FROM kb_pages p WHERE p.space_id = sp AND p.organization_id IS NULL AND p.title = v.title);
END $$;
