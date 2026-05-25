# tomat-core installer for Windows.
#
# Detects the host triple, downloads the signed core manifest from the CDN,
# picks the matching binary, verifies its SHA-256, installs it to
# %USERPROFILE%\.tomat\core\bin\tomat-core.exe, creates the admin token + a
# Task Scheduler entry for auto-start, starts the daemon, and prints the
# initial pairing code.
#
# Trust model (read before pinning a vendor signing key here):
#   1. The installer is fetched over TLS from $env:TOMAT_CDN (au.tomat.ing
#      by default). Connection-level integrity is HTTPS.
#   2. The manifest at $env:TOMAT_CDN/manifests/core.json is also fetched
#      over HTTPS. Its Ed25519 signature is intentionally NOT verified by
#      this installer: PowerShell ships no minisign tool by default and
#      pulling one in would inflate the install surface. Instead, the
#      installer trusts the per-binary SHA-256 from the manifest and the
#      running tomat-core binary's own signature check (in
#      packages/tomat-core/src/update/self-updater.ts) to verify every
#      subsequent self-update from the same channel.
#   3. The bundled binary is hash-verified (Get-FileHash below) against
#      the manifest's `sha256`, so a single corrupted download is caught
#      even without manifest signature checking.
#
# Consequence: a compromised TLS chain on $env:TOMAT_CDN's certificate would
# let a MITM serve a malicious manifest + matching binary on the very first
# install. That risk window closes at first launch (manifest signature
# verification is mandatory inside the running binary).
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://au.tomat.ing/install/core.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_CDN              override CDN base URL (default: https://au.tomat.ing)
#   $env:TOMAT_CORE_HOME        override install root (default: %USERPROFILE%\.tomat\core)
#   $env:TOMAT_INSTALL_SERVICE  "1" (default) registers a Scheduled Task so the
#                               core boots on login. "0" skips it; the client
#                               launches the core on demand via the
#                               `start_local_core` Tauri command.
#   $env:TOMAT_INSTALL_BIND_ALL "1" seeds settings.json with server.bindAll=true
#                               so the freshly-installed core listens on
#                               0.0.0.0 and other LAN devices can pair. "0"
#                               (default) keeps the loopback bind.

$ErrorActionPreference = "Stop"

$Cdn = if ($env:TOMAT_CDN) { $env:TOMAT_CDN } else { "https://au.tomat.ing" }
$HomeDir = if ($env:TOMAT_CORE_HOME) { $env:TOMAT_CORE_HOME } else { Join-Path $HOME ".tomat\core" }
$BinDir = Join-Path $HomeDir "bin"
$WorkersDir = Join-Path $HomeDir "workers"
$StagingDir = Join-Path $HomeDir "staging"
$LogsDir = Join-Path $HomeDir "logs"
$ManifestUrl = "$Cdn/manifests/core.json"
$InstallService = if ($env:TOMAT_INSTALL_SERVICE) { $env:TOMAT_INSTALL_SERVICE } else { "1" }
$InstallBindAll = if ($env:TOMAT_INSTALL_BIND_ALL) { $env:TOMAT_INSTALL_BIND_ALL } else { "0" }

function Info($msg) { Write-Host ">>> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- detect triple --------------------------------------------------------

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
} else { Fail "32-bit Windows is not supported" }
$Triple = "$arch-pc-windows-msvc"
Info "host triple: $Triple"

# --- fetch + parse manifest -----------------------------------------------

Info "fetching $ManifestUrl"
$manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
if (-not $manifest.version) { Fail "manifest missing version" }
$entry = $manifest.binaries | Where-Object { $_.triple -eq $Triple } | Select-Object -First 1
if (-not $entry) { Fail "no binary for triple $Triple in manifest" }

Info "version $($manifest.version)"

# --- download + verify ----------------------------------------------------

foreach ($d in @($BinDir, $WorkersDir, $StagingDir, $LogsDir)) { [void](New-Item -ItemType Directory -Force -Path $d) }
$Tmp = Join-Path $StagingDir "tomat-core-$($manifest.version)-$([System.IO.Path]::GetRandomFileName()).exe"
Info "downloading $($entry.url)"
Invoke-WebRequest -Uri $entry.url -OutFile $Tmp -UseBasicParsing

$got = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLowerInvariant()
if ($got -ne $entry.sha256.ToLowerInvariant()) {
  Remove-Item -Force $Tmp
  Fail "sha256 mismatch: want $($entry.sha256), got $got"
}
Info "sha256 ok"

$Installed = Join-Path $BinDir "tomat-core.exe"
Move-Item -Force $Tmp $Installed
Info "installed to $Installed"

# --- download workers -----------------------------------------------------
# Worker .ts files are platform-independent and run as Deno subprocesses
# spawned by the core. Their npm deps download lazily into
# %USERPROFILE%\.tomat\core\deno-cache on first use.

if ($manifest.workers) {
  foreach ($w in $manifest.workers) {
    $wTmp = Join-Path $StagingDir "$($w.name)-$($manifest.version)-$([System.IO.Path]::GetRandomFileName())"
    Info "downloading worker $($w.name)"
    Invoke-WebRequest -Uri $w.url -OutFile $wTmp -UseBasicParsing
    $wGot = (Get-FileHash -Algorithm SHA256 -Path $wTmp).Hash.ToLowerInvariant()
    if ($wGot -ne $w.sha256.ToLowerInvariant()) {
      Remove-Item -Force $wTmp
      Fail "worker $($w.name) sha256 mismatch: want $($w.sha256), got $wGot"
    }
    $wDst = Join-Path $WorkersDir $w.name
    Move-Item -Force $wTmp $wDst
    Info "installed worker → $wDst"
  }
}

# --- download helpers -----------------------------------------------------
# Native helper binary (tomat-core-keychain). Filter by host triple so we
# only fetch the .exe for this machine.

if ($manifest.helpers) {
  foreach ($h in $manifest.helpers) {
    if ($h.triple -ne $Triple) { continue }
    $hFilename = "$($h.name).exe"
    $hTmp = Join-Path $StagingDir "$hFilename-$($manifest.version)-$([System.IO.Path]::GetRandomFileName())"
    Info "downloading helper $hFilename"
    Invoke-WebRequest -Uri $h.url -OutFile $hTmp -UseBasicParsing
    $hGot = (Get-FileHash -Algorithm SHA256 -Path $hTmp).Hash.ToLowerInvariant()
    if ($hGot -ne $h.sha256.ToLowerInvariant()) {
      Remove-Item -Force $hTmp
      Fail "helper $hFilename sha256 mismatch: want $($h.sha256), got $hGot"
    }
    $hDst = Join-Path $BinDir $hFilename
    Move-Item -Force $hTmp $hDst
    Info "installed helper → $hDst"
  }
}

# --- seed settings.json --------------------------------------------------

$SettingsFile = Join-Path $HomeDir "settings.json"
if ($InstallBindAll -eq "1" -and -not (Test-Path $SettingsFile)) {
  Set-Content -Path $SettingsFile -Value '{"server.bindAll":true}' -Encoding ascii
  Info "seeded $SettingsFile with server.bindAll=true"
}

# --- admin token ----------------------------------------------------------

$AdminTokenFile = Join-Path $HomeDir ".admin-token"
if (-not (Test-Path $AdminTokenFile) -or (Get-Item $AdminTokenFile).Length -eq 0) {
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
  Set-Content -Path $AdminTokenFile -Value $hex -NoNewline -Encoding ascii
  # NTFS perms: owner-only.
  $acl = Get-Acl $AdminTokenFile
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
    "FullControl", "Allow")
  $acl.SetAccessRule($rule)
  Set-Acl -Path $AdminTokenFile -AclObject $acl
  Info "admin token written to $AdminTokenFile"
}

# --- Scheduled Task for auto-start at logon -------------------------------

if ($InstallService -ne "1") {
  Info "skipping service install (TOMAT_INSTALL_SERVICE=$InstallService)"
  # Spawn the core ourselves so the pairing-code mint below works. The
  # client takes over supervision on its next launch via start_local_core.
  Start-Process -FilePath $Installed -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogsDir "core.stdout.log") `
    -RedirectStandardError (Join-Path $LogsDir "core.stderr.log")
  Info "started core in background"
} else {
  $TaskName = "tomat-core"
  $action = New-ScheduledTaskAction -Execute $Installed
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
      -RestartCount 5 -RestartInterval (New-TimeSpan -Seconds 30) -AllowStartIfOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description "tomat-core" | Out-Null
  Info "scheduled task '$TaskName' installed"

  # Start it now.
  Start-ScheduledTask -TaskName $TaskName
  Info "core started"
}

# --- print pairing code ----------------------------------------------------

Start-Sleep -Seconds 2
$admin = Get-Content -Raw -Path $AdminTokenFile
try {
  $resp = Invoke-RestMethod -Method Post `
    -Uri "http://127.0.0.1:7800/api/v1/pairing/codes" `
    -Headers @{ "X-Admin-Token" = $admin; "Content-Type" = "application/json" } `
    -Body "{}"
  if ($resp.code) {
    Write-Host ""
    Write-Host "  Pairing code: $($resp.code)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Open tomat-client -> Pair -> enter:"
    Write-Host "    URL : http://127.0.0.1:7800   (or this host's LAN IP)"
    Write-Host "    Code: $($resp.code)"
    Write-Host ""
    exit 0
  }
} catch {
  Write-Host ""
  Write-Host "tomat-core installed. Mint a pairing code with:"
  Write-Host "  `$admin = Get-Content -Raw '$AdminTokenFile'"
  Write-Host "  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7800/api/v1/pairing/codes ``"
  Write-Host "    -Headers @{ 'X-Admin-Token' = `$admin; 'Content-Type' = 'application/json' } -Body '{}'"
  Write-Host ""
}
