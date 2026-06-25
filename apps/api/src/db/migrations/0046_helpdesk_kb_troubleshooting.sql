-- Second batch of global Help Desk KB articles: typical problems / self-help
-- troubleshooting. Global (organization_id NULL), published, indexed by full-text search
-- and surfaced by the "Ask Anchor" virtual agent. Idempotent (insert-if-absent by title).

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
    ('My computer is running slowly',
     $md$# My computer is running slowly

Try these in order:

1. **Restart** the computer — this clears memory and pending updates. Many slowdowns end here.
2. **Close unused apps and browser tabs**, especially large ones (Teams, browsers with many tabs).
3. **Check for updates**: install pending Windows and app updates, then restart.
4. **Free up disk space** if storage is nearly full — see *Free up disk space*.
5. **Run for 10 minutes** after a restart; first-login sync can use resources briefly.

Still slow after a restart and updates? File a ticket and include how long it has been happening and which apps are affected.$md$,
     ARRAY['troubleshooting','performance','slow']),

    ('Wi-Fi won''t connect',
     $md$# Wi-Fi won't connect

1. Toggle **Wi-Fi off and on**, or use **Airplane mode** off/on.
2. **Forget the network**, then reconnect and re-enter the password.
3. **Restart** the computer and your router/hotspot if you control it.
4. Confirm other devices can reach the same network (to isolate the device vs the network).
5. For office/secure Wi-Fi, your device may need to be **enrolled/compliant** in Intune first.

Still offline? Note the network name and any error, and file a ticket. Use a wired connection or hotspot in the meantime.$md$,
     ARRAY['troubleshooting','wifi','network']),

    ('Add or fix a printer',
     $md$# Add or fix a printer

1. Make sure the printer is **on** and on the **same network** (or connected by USB).
2. Windows: **Settings → Bluetooth & devices → Printers & scanners → Add device**.
3. If it is listed but not printing, **remove** it and **re-add** it.
4. Check for a **paper jam**, empty tray, or offline status on the printer panel.
5. **Restart** the print spooler by restarting the computer.

Need a network/shared printer added, or it still won't print? File a ticket with the printer name/location.$md$,
     ARRAY['troubleshooting','printer','hardware']),

    ('Outlook isn''t sending or receiving email',
     $md$# Outlook isn't sending or receiving email

1. Check you are **online** (bottom of Outlook should not say *Working Offline* — if it does, toggle **Send/Receive → Work Offline** off).
2. Click **Send/Receive All Folders**.
3. Confirm the message isn't stuck in **Outbox** (large attachments can block it).
4. **Restart Outlook**; if prompted, sign in and approve MFA.
5. GovCloud: use **Outlook (Classic)**, not "new Outlook" — see *Use Outlook (Classic)*.

Still stuck? Check **https://portal.office.us** webmail to confirm mail flow, then file a ticket.$md$,
     ARRAY['troubleshooting','outlook','email']),

    ('Microsoft Teams: can''t join, no audio or video',
     $md$# Microsoft Teams: can't join, no audio or video

1. In the meeting, open **… → Settings → Devices** and pick the correct **speaker, microphone, and camera**.
2. Check the device isn't **muted** (in Teams and on the headset/hardware).
3. Close and **reopen Teams**; if it persists, **restart** the computer.
4. Allow Teams access to the **microphone/camera** in Windows **Settings → Privacy & security**.
5. On poor connections, **turn off incoming video** to improve audio.

Still failing on every call? File a ticket with your device type and whether it affects all meetings.$md$,
     ARRAY['troubleshooting','teams','audio','video']),

    ('OneDrive isn''t syncing',
     $md$# OneDrive isn't syncing

1. Check the **OneDrive cloud icon** in the system tray — a red X or pause means it needs attention.
2. If **paused**, click the icon → **Resume syncing**.
3. Confirm you are **signed in** to OneDrive with your work account.
4. Make sure you have **disk space** and that file names don't contain unsupported characters.
5. **Restart** OneDrive (close from the tray icon, then reopen) or restart the computer.

Files still not syncing? Note the file/folder and any error, and file a ticket.$md$,
     ARRAY['troubleshooting','onedrive','sync','files']),

    ('External display or dual monitors not detected',
     $md$# External display or dual monitors not detected

1. Check the **cable** is fully seated at both ends; try a different cable or port if possible.
2. Press **Windows + P** and choose **Extend** (or Duplicate).
3. Windows **Settings → System → Display → Detect**.
4. Power the monitor **off and on**; select the correct **input source** on the monitor.
5. **Restart** the computer with the monitor connected.

A docking station may need its own driver/power — if a dock is involved and the screen still won't show, file a ticket with the dock and monitor models.$md$,
     ARRAY['troubleshooting','display','monitor','hardware']),

    ('"Your password has expired"',
     $md$# "Your password has expired"

Passwords expire periodically for security.

1. When prompted at sign-in, choose **Update password** and set a new one that meets the complexity policy (don't reuse a recent password).
2. If you can't get to the prompt, reset at **https://passwordreset.microsoftonline.us** (GovCloud).
3. After changing it, **sign in again everywhere** — mail, VPN, and Wi-Fi may re-prompt; update saved passwords on your phone.

Locked out instead? File an **Account unlock / password reset** request.$md$,
     ARRAY['password','expired','account']),

    ('Microphone or speakers not working',
     $md$# Microphone or speakers not working

1. Check the correct **output/input device** is selected (Windows **Settings → System → Sound**).
2. Confirm volume isn't **muted** and the headset's inline mute is off.
3. Reseat the **plug/USB** or re-pair Bluetooth — see *Bluetooth device won't pair*.
4. Allow apps to use the **microphone** in **Settings → Privacy & security → Microphone**.
5. **Restart** the computer.

Works in some apps but not others? It's usually app permissions or device selection. Still nothing? File a ticket with your headset/device model.$md$,
     ARRAY['troubleshooting','audio','microphone','hardware']),

    ('Free up disk space (low storage)',
     $md$# Free up disk space (low storage)

1. Run **Storage Sense**: **Settings → System → Storage**, then review what's using space.
2. Empty the **Recycle Bin** and your **Downloads** folder.
3. Move large files to **OneDrive** and enable **Files On-Demand** to keep them in the cloud.
4. Uninstall apps you no longer use (**Settings → Apps**).
5. **Restart** to clear temporary files.

If you're constantly out of space, file a ticket — you may need a larger drive or a storage review.$md$,
     ARRAY['troubleshooting','storage','disk']),

    ('Access a shared folder or mapped drive',
     $md$# Access a shared folder or mapped drive

1. Make sure you're **on the network or VPN** — see *Connect to the VPN*.
2. Open **File Explorer** and paste the path (e.g. `\\server\share`) into the address bar.
3. If asked, sign in with your **work account**.
4. To reconnect a missing mapped drive, right-click **This PC → Map network drive** and re-enter the path.

Getting "access denied"? You may not have permission yet — file an **Access request** naming the folder and your manager.$md$,
     ARRAY['troubleshooting','files','access','network']),

    ('Browser problems: clear cache and cookies',
     $md$# Browser problems: clear cache and cookies

Pages not loading right, stuck logins, or stale content are often fixed by clearing cache.

1. Open the browser menu → **Settings → Privacy** → **Clear browsing data**.
2. Select **Cached images and files** and **Cookies**, then clear.
3. Close **all** browser windows and reopen.
4. Try an **InPrivate/Incognito** window to confirm it's a cache issue.
5. Make sure the browser is **up to date**.

Still broken in every browser? It may be the site or your account — file a ticket with the URL and error.$md$,
     ARRAY['troubleshooting','browser','cache']),

    ('An app won''t open or keeps crashing',
     $md$# An app won't open or keeps crashing

1. **Close it fully** (Task Manager → End task) and reopen.
2. **Restart** the computer — clears stuck processes and pending updates.
3. **Update** the app and Windows.
4. If it's a Microsoft 365 app, run an **Office repair**: Settings → Apps → Microsoft 365 → Modify → Quick Repair.
5. Reinstall from **Company Portal** if needed.

Note the **exact error message** and what you were doing, and file a ticket if it keeps crashing.$md$,
     ARRAY['troubleshooting','apps','crash']),

    ('"Access denied" to a file or site',
     $md$# "Access denied" to a file or site

1. Confirm you're signed in with your **work account** (not a personal one).
2. Make sure you're **on VPN** if it's an internal resource.
3. The resource may require **membership in a group** you don't have yet.
4. Sign out and back in to refresh your permissions.

If you still can't get in, file an **Access request** that names the exact file/site/app and your business need; approval may be required.$md$,
     ARRAY['troubleshooting','access','permissions']),

    ('Bluetooth device won''t pair',
     $md$# Bluetooth device won't pair

1. Make sure **Bluetooth is on**: **Settings → Bluetooth & devices**.
2. Put the device in **pairing mode** (check its manual — often hold the power button until it flashes).
3. **Remove** any old/failed entry for the device, then add it again.
4. Charge the device; low battery blocks pairing.
5. **Restart** the computer and retry.

Still won't pair? Note the device model and file a ticket.$md$,
     ARRAY['troubleshooting','bluetooth','hardware'])
  ) AS v(title, body, labels)
  WHERE NOT EXISTS (
    SELECT 1 FROM kb_pages p WHERE p.space_id = sp AND p.organization_id IS NULL AND p.title = v.title
  );
END $$;
