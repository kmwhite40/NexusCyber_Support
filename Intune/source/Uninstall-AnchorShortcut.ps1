<#
  Uninstall-AnchorShortcut.ps1
  Removes the "Anchor IT Support" shortcut and staged icon. Runs as SYSTEM.
#>
$ErrorActionPreference = 'SilentlyContinue'

$AppName    = 'Anchor IT Support'
$InstallDir = Join-Path $env:ProgramData 'Anchor IT Support'

Remove-Item -Path (Join-Path $env:PUBLIC "Desktop\$AppName.url") -Force
Remove-Item -Path (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$AppName.url") -Force
Remove-Item -Path $InstallDir -Recurse -Force

Write-Output "Removed '$AppName' shortcut."
exit 0
