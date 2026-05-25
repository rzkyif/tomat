# tomat-client uninstaller for Windows.
#
# Finds the installed MSI via the Win32_Product / Uninstall registry path,
# then runs `msiexec /x` silently. Client settings under
# %USERPROFILE%\.tomat\client\ are LEFT IN PLACE unless -Purge is passed.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://au.tomat.ing/install/client-uninstall.ps1 | iex"
#   powershell -ExecutionPolicy Bypass -Command "& { $env:TOMAT_PURGE='1'; iwr -useb https://au.tomat.ing/install/client-uninstall.ps1 | iex }"

param(
  [switch]$Purge
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host ">>> $msg" -ForegroundColor Cyan }

# --- locate the installed product ----------------------------------------

$UninstallKeys = @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

$product = $null
foreach ($key in $UninstallKeys) {
  $product = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and $_.DisplayName -match "^Tomat" } |
    Select-Object -First 1
  if ($product) { break }
}

if (-not $product) {
  Write-Host "warn: tomat-client install not found in the registry; nothing to remove." -ForegroundColor Yellow
} else {
  Info "found $($product.DisplayName) (version $($product.DisplayVersion))"
  $code = $product.PSChildName
  Info "running msiexec /x $code (quiet)"
  $proc = Start-Process -FilePath "msiexec.exe" `
    -ArgumentList "/x", $code, "/qb", "/norestart" `
    -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    Write-Host "warn: msiexec exited with $($proc.ExitCode)" -ForegroundColor Yellow
  } else {
    Info "uninstall complete"
  }
}

# --- purge client data ---------------------------------------------------

$ClientDir = Join-Path $HOME ".tomat\client"
if ($Purge) {
  if (Test-Path $ClientDir) {
    Info "removing $ClientDir (per -Purge)"
    Remove-Item -Recurse -Force $ClientDir
  }
} else {
  if (Test-Path $ClientDir) {
    Write-Host "  Settings in $ClientDir were left in place. Re-run with -Purge to remove."
  }
}
