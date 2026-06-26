<#
  Install-AnchorShortcut.ps1
  Deploys the "Anchor IT Support" website shortcut to all users on a workstation.
  - Copies the Anchor icon to %ProgramData%\Anchor IT Support\anchor.ico
  - Creates "Anchor IT Support.url" (-> https://anchor.azurewebsites.us) on the
    All-Users (Public) Desktop and the All-Users Start Menu, using the Anchor icon.
  Designed to run as SYSTEM via Intune (Win32 app or platform script).
#>
$ErrorActionPreference = 'Stop'

$AppName    = 'Anchor IT Support'
$Url        = 'https://anchor.azurewebsites.us'
$InstallDir = Join-Path $env:ProgramData 'Anchor IT Support'
$IconPath   = Join-Path $InstallDir 'anchor.ico'

# 1) Stage the icon in a stable, machine-wide location.
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'anchor.ico') -Destination $IconPath -Force

# 2) Internet Shortcut content (opens in the user's default browser; custom icon).
$shortcut = @"
[InternetShortcut]
URL=$Url
IconFile=$IconPath
IconIndex=0
"@

# 3) Write the shortcut to the Public Desktop and the All-Users Start Menu.
$targets = @(
    (Join-Path $env:PUBLIC 'Desktop'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $targets) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -Path (Join-Path $dir "$AppName.url") -Value $shortcut -Encoding ASCII -Force
}

# 4) Detection marker.
Set-Content -Path (Join-Path $InstallDir 'installed.txt') -Value (Get-Date -Format o) -Encoding ASCII -Force

Write-Output "Installed '$AppName' shortcut for all users."
exit 0
