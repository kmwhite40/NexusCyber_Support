-- Additional global Help Desk knowledge-base articles (in support of the help desk and
-- the "Ask Anchor" virtual agent). Global = organization_id NULL, published, so they are
-- visible to every tenant and indexed by KB full-text search. Idempotent (insert-if-absent
-- by title within the global Help Desk space). tsv is a generated column — no need to set it.

DO $$
DECLARE sp uuid;
BEGIN
  SELECT id INTO sp FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk';
  IF sp IS NULL THEN
    INSERT INTO kb_spaces (organization_id, key, name, description)
      VALUES (NULL, 'helpdesk', 'Help Desk', 'Self-service answers for the most common IT requests')
      RETURNING id INTO sp;
  END IF;

  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('Reset your password (GovCloud)',
     $md$# Reset your password (GovCloud)

GovCloud (GCC High / DoD) tenants use the US Government cloud endpoints (`*.us`), not the commercial `.com` portals.

## Reset it yourself (recommended)
1. Go to **https://passwordreset.microsoftonline.us**.
2. Enter your work email and the on-screen characters.
3. Verify with a method you registered (Authenticator approval, text, or call).
4. Set a new password that meets the complexity policy (do not reuse a recent one).
5. Sign in again everywhere — mail, VPN, and Wi-Fi may each re-prompt.

> Self-service reset requires that you registered authentication methods first. If you have not, see **Set up MFA**.

## If self-service won't let you in
Open an **Account unlock / password reset** request from the Service catalog. We verify your identity out-of-band before resetting.$md$,
     ARRAY['password','govcloud','account']),

    ('Set up MFA with Microsoft Authenticator (GovCloud)',
     $md$# Set up MFA with Microsoft Authenticator (GovCloud)

Multi-factor authentication (MFA) protects your account. Register at least **two** methods so you are never locked out.

1. On a computer, go to **https://aka.ms/ssprsetup** (redirects to the Government **My Sign-ins → Security info** page, `mysignins.microsoft.us`).
2. Choose **Add sign-in method → Microsoft Authenticator** and follow the prompts on your phone.
3. Add a second method (a mobile phone number for text/call) as a backup.
4. Approve the test prompt to confirm each method works.

## Lost the phone with Authenticator?
If you can still sign in, add Authenticator on the new phone first, then delete the old device. If you are locked out, file an **MFA reset** request — we verify your identity, then you re-register at next sign-in.$md$,
     ARRAY['mfa','authenticator','govcloud','security']),

    ('Unlock your account',
     $md$# Unlock your account

Too many failed sign-ins can temporarily lock your account.

1. Wait a few minutes and try again with the correct password.
2. If you forgot the password, reset it at **https://passwordreset.microsoftonline.us** (GovCloud).
3. Still locked out? File an **Account unlock** request from the Service catalog. A Tier 1 analyst will verify your identity and clear the lockout.$md$,
     ARRAY['account','lockout','password']),

    ('Enroll your device with Intune (Company Portal)',
     $md$# Enroll your device with Intune (Company Portal)

Enrolling lets you securely reach work email and apps on a compliant device.

1. Open a web browser and search for **"Company Portal"**, then download and install it (Microsoft Store on Windows, App Store / Google Play on mobile).
2. Open Company Portal and **sign in** with your work account; approve the MFA prompt.
3. Follow the prompts to **enroll** the device and install the compliance policy.
4. Wait for the device to show **Compliant** in Company Portal → Devices.

If a setting is flagged (OS update, passcode, encryption), complete it and re-check. Need help? File a **User Device Intune Enrollment** request.$md$,
     ARRAY['intune','enrollment','device','company portal']),

    ('Use Outlook (Classic) for work email in GovCloud',
     $md$# Use Outlook (Classic) for work email in GovCloud

For Microsoft 365 in GovCloud, use **Outlook (Classic)** only — the "new Outlook" is not supported in the government cloud.

## Desktop
1. Open Outlook. If you see a **"New Outlook"** toggle in the top-right, turn it **OFF** to return to Outlook (Classic).
2. Add your work account and approve the MFA prompt.

## Mobile
Use the **Microsoft Outlook** app (required for compliance — it keeps work data in a protected container). Native/built-in mail apps are not supported for work email.$md$,
     ARRAY['outlook','email','govcloud','m365']),

    ('Install approved software (Company Portal)',
     $md$# Install approved software (Company Portal)

Most approved apps are available on demand — no ticket required.

1. Open **Company Portal** (Windows/macOS) or the Intune app catalog on mobile.
2. Browse or search for the app and choose **Install**.
3. Wait for it to deploy; restart if prompted.

If the app you need is not listed, file a **Software installation** request with the app name, business justification, and your manager. Licensed or restricted software requires approval.$md$,
     ARRAY['software','install','company portal']),

    ('Connect to the VPN',
     $md$# Connect to the VPN

Use the VPN to reach internal resources from outside the office.

1. Make sure your device is enrolled and **compliant** in Intune.
2. Open your VPN client and sign in with your work account; approve the MFA prompt.
3. If the client is not installed, get it from **Company Portal** or file a **Remote access / VPN** request.

Trouble connecting? Confirm you have internet, the latest client, and that your account is not locked. If it persists, file a ticket with any error message.$md$,
     ARRAY['vpn','remote','network']),

    ('Set up work email on your phone',
     $md$# Set up work email on your phone

1. Install the **Microsoft Outlook** app from the App Store or Google Play.
2. Open it and add your **work account**; approve the MFA prompt.
3. If prompted, **enroll the device** or accept the app-protection policy.

Native/built-in mail apps are not supported for work email — they cannot meet the data-protection policy.$md$,
     ARRAY['email','mobile','outlook']),

    ('Report a phishing or suspicious email',
     $md$# Report a phishing or suspicious email

If an email looks suspicious, do **not** click links or open attachments.

1. In Outlook, use the **Report** button (Report phishing) if available.
2. Otherwise, forward it as an attachment to the security team, or file a **Report a security incident** request.
3. If you already clicked a link or entered your password, change your password immediately and report it as a security incident — time matters.

When in doubt, report it. It is always better to check.$md$,
     ARRAY['phishing','security','email']),

    ('Recover a BitLocker key',
     $md$# Recover a BitLocker key

If your Windows device asks for a BitLocker recovery key:

1. Note the **Key ID** shown on the recovery screen.
2. Sign in to **https://myaccount.microsoft.us** → Devices, or ask the help desk to retrieve the key from Entra/Intune.
3. Enter the 48-digit recovery key to unlock the device.

If you cannot retrieve it yourself, file a **BitLocker recovery key retrieval** request — a Tier 1 analyst will verify your identity and provide the key.$md$,
     ARRAY['bitlocker','encryption','device']),

    ('Lost or stolen device — what to do',
     $md$# Lost or stolen device — what to do

Act fast to protect work data.

1. File a **Lost / stolen device — wipe & revoke** request immediately (treated as urgent).
2. We revoke active sessions, disable sign-in, and remote-wipe the device.
3. Change your password from a trusted device and re-register MFA.

Report it even if you think it may turn up — a selective wipe is easy to reverse, a breach is not.$md$,
     ARRAY['security','device','incident']),

    ('Request a shared mailbox or distribution list',
     $md$# Request a shared mailbox or distribution list

- A **shared mailbox** lets a team send/receive from one address (e.g. support@…).
- A **distribution list** emails many people at once.

To request one, file a **Shared mailbox & distribution list** request and provide:
1. The desired **name/address**.
2. The **owner** and **members**.
3. Whether it should accept **external** email.

After it is created, the owner manages membership and delegate access on a least-privilege basis.$md$,
     ARRAY['email','mailbox','collaboration']),

    ('New employee first-day checklist',
     $md$# New employee first-day checklist

1. **Sign in** to your work account and set your password.
2. **Register MFA** (Microsoft Authenticator + a backup phone) — see *Set up MFA*.
3. **Enroll your device** with Company Portal — see *Enroll your device with Intune*.
4. **Set up email** in Outlook (Classic) on desktop and the Outlook app on mobile.
5. **Install the apps** you need from Company Portal.
6. Connect to **Wi-Fi/VPN** as needed.

Stuck on any step? Use **Ask Anchor** on the portal or file a request — the help desk will get you set up.$md$,
     ARRAY['onboarding','new hire','getting started'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (
    SELECT 1 FROM kb_pages p WHERE p.space_id = sp AND p.organization_id IS NULL AND p.title = v.title
  );
END $$;
