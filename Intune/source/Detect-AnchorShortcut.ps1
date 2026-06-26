<#
  Detect-AnchorShortcut.ps1
  Intune Win32 custom detection script. Intune treats the app as INSTALLED when
  this script exits 0 AND writes to STDOUT. Detects both the staged icon and the
  Public Desktop shortcut.
#>
$AppName  = 'Anchor IT Support'
$icon     = Join-Path $env:ProgramData 'Anchor IT Support\anchor.ico'
$desktop  = Join-Path $env:PUBLIC "Desktop\$AppName.url"

if ((Test-Path $icon) -and (Test-Path $desktop)) {
    Write-Output "Detected: $AppName"
    exit 0
}
exit 1
