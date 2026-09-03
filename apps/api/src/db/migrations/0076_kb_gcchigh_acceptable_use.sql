-- End-user KB for a GCC High tenant: acceptable use, data handling, and the environment-specific
-- gaps the existing 67 articles do not cover.
--
-- WRITTEN FOR GCC HIGH ON PURPOSE. Every onboarded organization is cloud='gcchigh', and the
-- platform's own cloud_environments table records why that matters: gcc authenticates against
-- login.microsoftonline.com (the commercial identity environment) while gcchigh uses
-- login.microsoftonline.us. Commercial or GCC wording here would send users to a sign-in portal
-- that does not hold their account — so the identity links below are the -us ones, deliberately.
--
-- Each article was checked against the existing titles first; anything already covered (password
-- reset, MFA setup, phishing reporting, lost devices, OneDrive sync, CUI handling) is NOT
-- repeated. What remains is mostly acceptable-use policy, which had no equivalent at all.
--
-- Idempotent: insert-if-absent by title, matching 0045/0046.

DO $$
DECLARE sp_sec uuid; sp_m365 uuid; sp_sd uuid;
BEGIN
  SELECT id INTO sp_sec  FROM kb_spaces WHERE organization_id IS NULL AND key = 'SEC';
  SELECT id INTO sp_m365 FROM kb_spaces WHERE organization_id IS NULL AND key = 'M365';
  SELECT id INTO sp_sd   FROM kb_spaces WHERE organization_id IS NULL AND key = 'SD';
  IF sp_sec IS NULL OR sp_m365 IS NULL OR sp_sd IS NULL THEN
    RAISE NOTICE 'kb spaces missing; seed has not run. Skipping GCC High article load.';
    RETURN;
  END IF;

  -- ---------------- Security & acceptable use ----------------
  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp_sec, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('Can I send work files to my personal email?',
     $md$# Can I send work files to my personal email?

**No.** Not to Gmail, Outlook.com, iCloud, or any personal account — including your own.

This is not a technicality. Work information lives in this tenant because the tenant carries the
compliance commitments our contracts depend on. A copy in a personal mailbox sits outside all of
them: it is not covered by our retention rules, cannot be produced for an audit, and cannot be
recovered or removed if that account is ever compromised.

**Instead:**

- Working from home or another device? Use **Outlook on the web**, Teams, or the VPN.
- Need a file on your phone? Use the OneDrive or Office apps signed in with your work account.
- Need to send something to someone outside SBS? See *Sharing with people outside your organization*.

If you have already done this, say so — tell the Service Desk what was sent and when. It is a
small conversation now and a much larger one if it surfaces in an audit later.$md$,
     ARRAY['acceptable-use','data-handling','email','policy']),

    ('Can I use Dropbox, Google Drive, or other cloud storage?',
     $md$# Can I use Dropbox, Google Drive, or other cloud storage?

**No** — not for work information, on any device.

Approved storage is **OneDrive**, **SharePoint**, and **Teams**, all inside this tenant. Consumer
cloud services are outside the compliance boundary our contracts require, and most of them
process and store data in locations we cannot attest to.

This includes the ones that feel harmless: a personal Dropbox for "just moving a file between my
own machines", a Google Doc for quick collaboration, a file-transfer site because an attachment
was too large.

**If a file is too large to email**, share it from OneDrive or SharePoint instead — that produces
a link, not a copy, and the permissions travel with it.

If you need a capability our approved tools genuinely do not have, raise a ticket. There may be
an approved option, and if there is not, that is worth knowing.$md$,
     ARRAY['acceptable-use','data-handling','storage','policy']),

    ('Can I use ChatGPT or other AI tools with work data?',
     $md$# Can I use ChatGPT or other AI tools with work data?

**Do not paste work information into public AI tools.** That includes ChatGPT, Claude, Gemini,
Copilot outside our tenant, AI browser extensions, meeting-transcription bots, and "free" code
assistants.

Specifically, never submit:

- **CUI or anything covered by a contract**
- Customer names, data, or deliverables
- Credentials, keys, or configuration
- Internal documents, code, or security details
- Personnel or HR information

**Why it matters here.** Text sent to a public AI service leaves the tenant. Depending on the
service it may be retained, reviewed by humans, or used for training — and once submitted it
cannot be recalled. For CUI that is a reportable disclosure, not a policy slip.

**What is fine:** general questions that contain nothing of ours. "How do I write a VLOOKUP" is
fine. "Here is our customer's data, write a VLOOKUP for it" is not.

Approved AI capability inside the tenant is a different thing and subject to its own rules — if
you want to use AI for real work, ask, rather than assuming which category a tool falls into.$md$,
     ARRAY['acceptable-use','ai','data-handling','cui','policy']),

    ('Using USB drives and removable media',
     $md$# Using USB drives and removable media

Use only removable media issued or approved by IT, and only where policy allows it.

- **Never plug in a drive you found**, were handed at a conference, or received in the post.
  Malicious USB devices are cheap and still effective.
- **Do not copy work information onto personal drives**, including your own.
- **Encryption is required** for anything approved to leave a building.
- **CUI on removable media** needs specific authorization — see *Handling Controlled Unclassified
  Information (CUI)*.

If your device blocks a USB drive, that is policy working, not a fault. Raise a ticket rather
than looking for a way around it, and say what you were trying to move — there is usually an
approved route.$md$,
     ARRAY['acceptable-use','devices','removable-media','cui','policy']),

    ('Working from a personal computer',
     $md$# Working from a personal computer

Work on **managed, company-issued devices**. They carry the encryption, patching, Defender and
Intune policies our compliance obligations are built on; a personal machine carries none of them
and we cannot attest to its state.

**What is generally acceptable** on a personal device: Outlook on the web and Teams in a browser,
signed in with your work account, with nothing downloaded and stored locally.

**What is not:** installing the desktop apps, syncing OneDrive, saving work files locally,
storing anything containing CUI, or letting family members use a session you are signed into.

**Never** use a personal device as a workaround for a broken work laptop — raise a ticket. Losing
a day is recoverable; an uncontrolled copy of customer data is not.$md$,
     ARRAY['acceptable-use','devices','remote-work','policy']),

    ('Using public or hotel Wi-Fi',
     $md$# Using public or hotel Wi-Fi

Public Wi-Fi is usable with care, on a managed device.

1. **Connect to the VPN** before doing anything work-related — see *Connect to the VPN*.
2. **Check the network name** with staff. Attacker-run hotspots imitate hotel and airport
   networks, often with a more convincing name than the real one.
3. **Never accept a certificate warning** on a public network. That is the one warning that most
   often means exactly what it says.
4. **Watch your screen** in the open. Shoulder-surfing needs no exploit, and a boarding lounge is
   a good place for it.

Avoid entirely on public Wi-Fi: authenticating to admin consoles, and working with CUI unless
policy explicitly permits it from that location.

Tethering to your phone is usually safer than an open network.$md$,
     ARRAY['acceptable-use','remote-work','vpn','network','policy']),

    ('You approved an MFA prompt you did not start',
     $md$# You approved an MFA prompt you did not start

**Tell the Service Desk immediately.** Someone has your password and is trying to get past MFA.

Approving by reflex is common and it is not a stupid mistake — attackers send prompts repeatedly,
often at night, precisely so that someone taps approve to make them stop. What matters is what
happens next.

**Right now:**

1. **Report it.** Do not wait to see whether anything happens; by then it has.
2. **Change your password** — see *Reset your password*.
3. **Do not approve any further prompts**, including ones that look routine.

**If you denied it instead**, that is the right answer — but still report it if prompts keep
arriving. Repeated prompts mean your password is already known.

**A prompt you did not start is never a glitch.** Every push corresponds to a real sign-in
attempt with your password.$md$,
     ARRAY['security','mfa','incident','phishing']),

    ('You clicked a link in a phishing email',
     $md$# You clicked a link in a phishing email

Report it now. **Nobody is in trouble for clicking** — the damage comes from the delay while
someone decides whether to mention it.

**Do this, in order:**

1. **Stop.** Close the page. Do not enter anything else, and do not "test whether it is real".
2. **If you entered your password**, tell the Service Desk immediately and change it — see
   *Reset your password*. Assume the old one is known.
3. **If you approved an MFA prompt afterwards**, say so explicitly. See *You approved an MFA
   prompt you did not start*.
4. **If you opened an attachment**, leave the machine on and connected, and say so. Disconnecting
   can destroy evidence that shows what actually ran.
5. **Do not delete the email.** It is evidence.

**Tell us even if nothing seemed to happen.** Many credential-harvesting pages look broken on
purpose, so the visit feels like a dead end while the credentials are already gone.$md$,
     ARRAY['security','phishing','incident','response']),

    ('Microsoft Defender flagged a file or blocked an app',
     $md$# Microsoft Defender flagged a file or blocked an app

**Stop using the file or application and raise a ticket.** Include the exact alert text or a
screenshot, what you were doing, and where the file came from.

**Do not:**

- **Disable Defender, or exclude a folder, to make something work.** If you can do it, an
  attacker who reaches your session can do it too — and the exclusion usually outlives the
  reason for it.
- **Re-download the file from the same place** to see whether it works the second time.
- **Forward it to a colleague** to check whether they get the same warning.

**A block is not always malware** — it may be an unsigned installer or an unapproved tool, and
the answer may simply be an approved alternative. But that call belongs to the people who can see
the whole picture. Say what you were trying to achieve, not just what was blocked.$md$,
     ARRAY['security','defender','malware','incident'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (
    SELECT 1 FROM kb_pages p WHERE p.organization_id IS NULL AND p.title = v.title
  );

  -- ---------------- Understanding the environment ----------------
  INSERT INTO kb_pages (organization_id, space_id, title, body, labels, status, published_at, version)
  SELECT NULL, sp_m365, v.title, v.body, v.labels, 'published', now(), 1
  FROM (VALUES
    ('What GCC High means for you',
     $md$# What GCC High means for you

We run **Microsoft 365 GCC High** — the environment Microsoft operates for defense contractors
and organizations handling controlled information. It is a separate cloud, not a setting on the
ordinary one.

**What that changes day to day:**

- **Different web addresses.** Ours end in **`.us`** — `portal.office365.us`,
  `*.sharepoint.us`, `gov.teams.microsoft.us`. Microsoft's public help pages usually show the
  commercial `.com` equivalents, which will not work for you.
- **A separate identity system.** Sign-in goes to **login.microsoftonline.us**. A personal or
  commercial Microsoft account cannot sign in here, whatever the address on it.
- **Some features arrive later, or not at all.** GCC High trails the commercial cloud
  deliberately. A feature you have seen elsewhere may simply not exist here yet.
- **External collaboration is narrower**, by design. See *Sharing with people outside your
  organization*.

**GCC High is not the same as GCC.** They are different clouds with different sign-in addresses
and different feature sets, and instructions written for one can send you somewhere that does not
hold your account. If you are following a guide, check the URLs before the steps.

See also *Why Microsoft's help links often do not work for us*.$md$,
     ARRAY['gcchigh','environment','getting-started']),

    ('Why Microsoft''s help links often do not work for us',
     $md$# Why Microsoft's help links often do not work for us

You searched a Microsoft help page, followed the link, and either landed somewhere that does not
recognise your account or saw a screen that looks nothing like yours. Nothing is broken.

Microsoft's public documentation is written for the **commercial** cloud. We are in **GCC High**,
which has its own addresses.

- `myaccount.microsoft.com` -> use `myaccount.microsoft.us`
- `aka.ms/MySecurityInfo` -> use **`aka.ms/MySecurityInfo-us`**
- `portal.office.com` -> use `portal.office365.us`
- `teams.microsoft.com` -> use `gov.teams.microsoft.us`
- `*.sharepoint.com` -> use `*.sharepoint.us`
- `login.microsoftonline.com` -> use `login.microsoftonline.us`

**The security-info one matters most.** `aka.ms/MySecurityInfo` is the commercial identity
environment. Signing in there with your work account will not show your MFA methods, because your
account does not live there — which reads like a broken account when it is only a wrong address.

**Rule of thumb:** if a Microsoft URL has no `.us` in it, it is probably not ours. The steps in
their article are usually still right; the address is not.$md$,
     ARRAY['gcchigh','environment','troubleshooting','mfa']),

    ('OneDrive or SharePoint — where should this file live?',
     $md$# OneDrive or SharePoint — where should this file live?

A simple test: **would someone need this if you were unavailable for a month?**

**OneDrive** is your own working space — drafts, notes, a file you are still shaping. It is yours,
and it disappears from view when your account is deprovisioned.

**SharePoint or Teams** is where work that belongs to the organization lives — anything a project,
a customer, or a colleague depends on.

**Why it matters more than it sounds.** When someone leaves, their OneDrive goes with their
account. Every offboarding turns up a project's only copy of something important sitting in a
departing person's OneDrive, and recovering it is a scramble on someone's last day at best.

**A good habit:** draft in OneDrive, then move it to the team's site the moment anyone else needs
it. If you are sharing a OneDrive link with more than one person, it probably belongs in
SharePoint instead.$md$,
     ARRAY['onedrive','sharepoint','files','offboarding']),

    ('Where files shared in Teams actually live',
     $md$# Where files shared in Teams actually live

Teams does not store files. It shows you files that live somewhere else, which explains most
"where did it go" questions.

- **A file posted in a channel** lives in that team's **SharePoint** site, under a folder named
  after the channel. Anyone in the team can reach it.
- **A file sent in a chat or direct message** lives in the **OneDrive of whoever sent it**, shared
  with the people in that chat.

**What follows from that:**

- Removing someone from a team removes their access to channel files immediately.
- A file shared in a private chat depends on the sender's OneDrive — **when they leave, it can go
  with them.** Anything that matters belongs in a channel, not a DM.
- Deleting a message does not delete the file. Delete it in SharePoint or OneDrive.

**To find a file again:** open the channel's **Files** tab, or search in SharePoint rather than
scrolling Teams history.$md$,
     ARRAY['teams','sharepoint','onedrive','files']),

    ('Sharing with people outside your organization',
     $md$# Sharing with people outside your organization

External sharing in GCC High is deliberately narrow, and what you can do depends on tenant
policy, the specific site, and the sensitivity label on the document.

**Before sharing anything outward, check three things:**

1. **What is in it.** CUI and contract-controlled material have their own rules — see *Handling
   Controlled Unclassified Information (CUI)*.
2. **Who the recipient actually is.** Confirm the address through a known channel, not by
   replying to the request. Requests to "share the file with my other address" are a routine
   attack.
3. **What access they need.** View is almost always enough. Default to it.

**If the Share button will not let you**, that is usually policy rather than a fault — a label, a
DLP rule, or a site restriction. See *You cannot share a file and do not know why*.

**Do not work around it** by emailing a copy, using a personal account, or uploading elsewhere.
The restriction exists because someone decided that data should not leave this way; if the
business need is real, raise a ticket and it can be reviewed.

Note that guest access in GCC High is more limited than in the commercial cloud, and a partner in
a commercial tenant may not be reachable the way you expect.$md$,
     ARRAY['sharing','external','sharepoint','onedrive','cui','policy']),

    ('Recording a Teams meeting',
     $md$# Recording a Teams meeting

Whether you can record depends on licensing and policy, and whether you *should* is a separate
question.

**Before recording:**

- **Say so out loud** and give people a chance to object. Teams announces it, but announcing it
  yourself is what makes consent real.
- **Consider the content.** A meeting covering CUI or customer-controlled information produces a
  recording covering it too — stored, searchable, and shareable by anyone who receives the link.
- **Check the customer's rules.** Some contracts restrict recording government or customer
  discussions entirely.

**After recording:** the file lands in OneDrive or SharePoint depending on the meeting type, and
it inherits that location's sharing rules — not the meeting's attendee list. Check who can reach
it before sending the link on.

**If recording is unavailable**, that is usually deliberate. Ask rather than looking for another
capture tool — a personal screen recorder is a far worse answer than no recording.$md$,
     ARRAY['teams','meetings','recording','cui','policy']),

    ('Third-party apps, add-ins and connectors',
     $md$# Third-party apps, add-ins and connectors

**Do not install or connect third-party apps to your work account without approval.** This covers
Teams apps, Outlook add-ins, browser extensions that read mail or documents, and anything asking
to "connect" to Microsoft 365.

**What you are actually agreeing to.** When one of these asks for permission, it is usually asking
for standing access to read your mail, files, or calendar — not a one-off. That access survives
password changes, and it runs from the vendor's servers, outside our tenant and outside the
compliance boundary GCC High exists to provide.

**The consent prompt is the decision point.** Once granted, an app can read what it was given
access to at any time, whether or not you are using it.

**If you need a tool**, raise a ticket describing what you are trying to do. Approval exists so
someone can check where the data goes — and often there is an approved capability already.

**If you have already connected something**, say so. Revoking it is straightforward; finding out
later from a log is not.$md$,
     ARRAY['acceptable-use','apps','consent','security','policy'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (
    SELECT 1 FROM kb_pages p WHERE p.organization_id IS NULL AND p.title = v.title
  );
END $$;
