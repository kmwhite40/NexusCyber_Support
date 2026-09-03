# Anchor IT Support — Intune Deployment Package

Deploys an **"Anchor IT Support"** desktop & Start-menu shortcut to end-user
Windows workstations. The shortcut opens the Anchor portal
(**https://anchor.azurewebsites.us**) in the user's default browser and uses the
**Anchor icon**.

This is an MSP/IT-admin package — end users do nothing; the shortcut simply
appears for everyone on the device after Intune applies it.

---

## Contents

| File | Purpose |
|------|---------|
| `Anchor IT Support.url` | Standalone shortcut (double-click to test locally; keep next to `source\anchor.ico` for the icon). |
| `source/anchor.ico` | The Anchor icon (multi-resolution 16–256 px). |
| `source/Install-AnchorShortcut.ps1` | Creates the all-users shortcut + stages the icon. |
| `source/Uninstall-AnchorShortcut.ps1` | Removes the shortcut + icon. |
| `source/Detect-AnchorShortcut.ps1` | Win32 detection script. |
| `README.md` | This guide. |

**What gets created on the workstation (SYSTEM context):**
- `C:\ProgramData\Anchor IT Support\anchor.ico`
- `C:\Users\Public\Desktop\Anchor IT Support.url`
- `…\ProgramData\Microsoft\Windows\Start Menu\Programs\Anchor IT Support.url`

---

## Option A — Win32 app (recommended: full install / uninstall / detection)

### 1. Package with the Microsoft Win32 Content Prep Tool
Download **IntuneWinAppUtil.exe** from
<https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool>, then from this
folder run:

```powershell
IntuneWinAppUtil.exe -c .\source -s Install-AnchorShortcut.ps1 -o .\output
```

This produces `output\Install-AnchorShortcut.intunewin`.

### 2. Create the app in Intune
Intune admin center → **Apps → Windows → Add → App type: Windows app (Win32)** →
upload `Install-AnchorShortcut.intunewin`.

> Government tenants use the **Intune for Government** portal:
> <https://intune.microsoft.us> (commercial: <https://intune.microsoft.com>).

**Program**
| Field | Value |
|------|-------|
| Install command | `powershell.exe -ExecutionPolicy Bypass -File Install-AnchorShortcut.ps1` |
| Uninstall command | `powershell.exe -ExecutionPolicy Bypass -File Uninstall-AnchorShortcut.ps1` |
| Install behavior | **System** |
| Device restart behavior | No specific action |

**Requirements:** OS architecture x64 (and/or x86) · Minimum OS Windows 10 1809+.

**Detection rules:** choose **Use a custom detection script** and upload
`source\Detect-AnchorShortcut.ps1`.
*(Alternative simple rule — Rule type: File · Path `%ProgramData%\Anchor IT Support` ·
File `anchor.ico` · "File or folder exists".)*

### 3. Assign
**Assignments → Required** → add your end-user **device** or **user** groups
(e.g., "All Workstations"). Use **Available for enrolled devices** instead if you
want it in Company Portal as opt-in.

Devices pick it up at the next Intune sync (or **Settings → Accounts → Access work
or school → Info → Sync**).

---

## Option B — Platform script (quickest; no uninstall/detection lifecycle)

Intune admin center → **Devices → Scripts and remediations → Platform scripts →
Add → Windows 10 and later**, upload `source\Install-AnchorShortcut.ps1` with:

- **Run this script using the logged-on credentials:** **No** (run as SYSTEM)
- **Enforce script signature check:** No
- **Run script in 64-bit PowerShell:** Yes

Then assign to your groups. *(The icon is embedded by the script, which copies
`anchor.ico` from its own folder — keep `anchor.ico` alongside the .ps1 in the
upload, which the Win32 packaging in Option A handles automatically. For Option B,
prefer the Win32 route if the icon must travel with the script.)*

---

## Verify on a test device
1. Sync Intune, wait for delivery.
2. Confirm **Anchor IT Support** appears on the desktop and Start menu with the
   Anchor icon.
3. Double-click → the Anchor portal opens at `https://anchor.azurewebsites.us`.
4. (Win32) Intune **Apps → Monitor** shows Installed.

## Customize
- **Different URL / name:** edit `$Url` / `$AppName` at the top of
  `Install-AnchorShortcut.ps1` (also update the Uninstall/Detect scripts to match).
- **Desktop only (no Start menu):** remove the Start-menu path from the
  `$targets` array in `Install-AnchorShortcut.ps1`.

## Notes
- Scripts run as **SYSTEM**, so the shortcut is created for **all users** on the
  device (Public Desktop + All-Users Start menu).
- The `.url` Internet Shortcut opens in whatever browser is set as default.
- No admin rights or action required from end users.
