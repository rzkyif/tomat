# tomat-client installer for Windows.
#
# Fetches client.json from the CDN, picks the MSI for x86_64-pc-windows-msvc,
# downloads it, strips the Mark of the Web (MOTW) attribute so SmartScreen
# doesn't show the "Windows protected your PC" warning, then runs `msiexec /i`
# silently.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://au.tomat.ing/install/client.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_CDN  override CDN base URL (default: https://au.tomat.ing)

$ErrorActionPreference = "Stop"

$Cdn = if ($env:TOMAT_CDN) { $env:TOMAT_CDN } else { "https://au.tomat.ing" }
$ManifestUrl = "$Cdn/manifests/client.json"

function Info($msg) { Write-Host ">>> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- detect triple --------------------------------------------------------

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
} else { Fail "32-bit Windows is not supported" }
$Triple = "$arch-pc-windows-msvc"
Info "host triple: $Triple"

# --- fetch manifest -------------------------------------------------------

Info "fetching $ManifestUrl"
$manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
if (-not $manifest.version) { Fail "manifest missing version" }
$entry = $manifest.platforms.$Triple
if (-not $entry -or -not $entry.url) { Fail "no client artifact for triple $Triple" }
Info "version $($manifest.version) -> $($entry.url)"

# --- download + install ---------------------------------------------------

$Tmp = Join-Path $env:TEMP ("tomat-client-" + [System.IO.Path]::GetRandomFileName() + ".msi")
Info "downloading MSI"
Invoke-WebRequest -Uri $entry.url -OutFile $Tmp -UseBasicParsing

# Drop MOTW so SmartScreen doesn't gate the install on the "Windows protected
# your PC" dialog (which happens for any Internet-zone-tagged installer that
# isn't EV-signed). Unblock-File removes the Zone.Identifier alternate stream.
try {
  Unblock-File -Path $Tmp -ErrorAction SilentlyContinue
  Info "MOTW cleared"
} catch {
  Write-Host "warn: could not unblock $Tmp: $_" -ForegroundColor Yellow
}

Info "running msiexec /i (quiet)"
$proc = Start-Process -FilePath "msiexec.exe" `
  -ArgumentList "/i", "`"$Tmp`"", "/qb", "/norestart" `
  -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  Fail "msiexec exited with code $($proc.ExitCode)"
}

Remove-Item -Force $Tmp -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Tomat installed." -ForegroundColor Green
Write-Host "  Launch from the Start Menu (search for `"Tomat`")."
Write-Host ""
