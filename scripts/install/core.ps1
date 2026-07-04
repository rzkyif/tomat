# tomat-core installer for Windows.
#
# Detects the host triple, downloads the signed core manifest from the
# storage origin, picks the matching binary, verifies its SHA-256, installs
# it to %USERPROFILE%\.tomat\<channel>\core\bin\tomat-core.exe, creates the
# admin token + a Task Scheduler entry for auto-start, starts the daemon, and
# prints the initial pairing code.
#
# Trust model (read before pinning a vendor signing key here):
#   1. The installer is fetched over TLS from $env:TOMAT_STORAGE
#      (get.au.tomat.ing by default). Connection-level integrity is HTTPS.
#   2. The manifest at $env:TOMAT_STORAGE/manifests/core.json is also fetched
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
# Consequence: a compromised TLS chain on $env:TOMAT_STORAGE's certificate
# would let a MITM serve a malicious manifest + matching binary on the very
# first install. That risk window closes at first launch (manifest signature
# verification is mandatory inside the running binary).
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/core.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_STORAGE          override storage base URL (default: https://get.au.tomat.ing)
#   $env:TOMAT_CHANNEL          install channel: stable (default) | dev | latest. Selects
#                               the %USERPROFILE%\.tomat\<channel>\core subtree and is
#                               baked into the scheduled task so the daemon matches.
#   $env:TOMAT_CORE_HOME        override install root (default: %USERPROFILE%\.tomat\<channel>\core)
#   $env:TOMAT_INSTALL_SERVICE  "1" (default) registers a Scheduled Task so the
#                               core boots on login. "0" skips it; the client
#                               launches the core on demand via the
#                               `start_local_core` Tauri command.
#   $env:TOMAT_INSTALL_BIND_ALL "1" seeds settings.json with
#                               server.bindHost=0.0.0.0 so the freshly-installed
#                               core listens on all interfaces and other LAN
#                               devices can pair. "0" (default) keeps loopback.
#   $env:TOMAT_INSTALL_BEHIND_PROXY
#                               "1" seeds settings.json with
#                               server.behindProxy=true for a core served
#                               through an HTTPS reverse proxy: clients then
#                               trust the proxy's real certificate when pairing
#                               instead of pinning the core's own. Must be set
#                               before the first pair. "0" (default) pins.
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*] (no spinner on Windows -- Start-Job overhead is significant;
#   loops mutate the suffix instead), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   Windows 10 1809+ and Windows 11 (UTF-8 capable conhost / Terminal).

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (the `powershell.exe` this one-liner runs under) redraws
# the Invoke-WebRequest progress bar on every socket read, throttling -OutFile
# downloads to a fraction of the link speed. Suppressing progress restores full
# throughput on the multi-tens-of-MB core binary + workers.
$ProgressPreference = "SilentlyContinue"

# ===== UI helpers begin =====
# Self-contained UI helper block. Keep this region intact so future install
# scripts can copy it verbatim. No external state, no shared library --
# everything below operates on $script: variables only.

# --- UI state -------------------------------------------------------------

$script:UiTty         = -not [Console]::IsOutputRedirected
$script:UiRowsTotal   = 0
$script:UiCurrent     = -1
$script:UiTopRow      = 0
$script:UiLabels      = @()
$script:UiCurrentLabel = ""
$script:UiCurrentSuffix = ""
$script:UiStagingPaths = New-Object System.Collections.ArrayList
$script:UiCleanupInstalled = $false

# Glyphs. ASCII baseline; upgrade to unicode on Windows 10 1809+ which
# defaults to a UTF-8 capable conhost. We always attempt unicode -- if the
# host can't render it the layout stays intact, just with substitute glyphs.
$script:UiGlyphPend  = " "
$script:UiGlyphDoing = "*"
$script:UiGlyphDone  = [char]0x2713  # checkmark
$script:UiGlyphSkip  = "~"
$script:UiGlyphErr   = [char]0x2717  # cross

# --- low-level row rendering ---------------------------------------------

function _Ui-FormatRow($glyph, $label, $suffix) {
  if ($suffix) {
    return "  [$glyph] $label $suffix"
  } else {
    return "  [$glyph] $label"
  }
}

# Emit a row in non-TTY mode (one line per state transition).
function _Ui-EmitRow($glyph, $color, $label, $suffix) {
  $text = _Ui-FormatRow $glyph $label $suffix
  if ($color) {
    Write-Host $text -ForegroundColor $color
  } else {
    Write-Host $text
  }
}

# Repaint row $idx in-place. TTY only -- caller must check $script:UiTty.
# The glyph/label/suffix get printed; the dim suffix uses DarkGray.
function _Ui-RepaintRow($idx, $glyph, $color, $label, $suffix) {
  $y = $script:UiTopRow + $idx
  try {
    [Console]::SetCursorPosition(0, $y)
  } catch {
    # Window resized below us, etc. -- fall back to a fresh line.
    _Ui-EmitRow $glyph $color $label $suffix
    return
  }
  # Erase the line first by writing spaces over it, then rewind.
  $width = [Console]::WindowWidth
  if ($width -lt 1) { $width = 80 }
  [Console]::Write((" " * ($width - 1)))
  [Console]::SetCursorPosition(0, $y)
  # Now write the actual row contents.
  Write-Host "  [" -NoNewline
  if ($color) {
    Write-Host $glyph -NoNewline -ForegroundColor $color
  } else {
    Write-Host $glyph -NoNewline
  }
  Write-Host "] $label" -NoNewline
  if ($suffix) {
    Write-Host " $suffix" -NoNewline -ForegroundColor DarkGray
  }
  # Park the cursor below the last row so subsequent Write-Host appends in
  # the right place if the UI block is followed by plain output.
  $tail = $script:UiTopRow + $script:UiRowsTotal
  try { [Console]::SetCursorPosition(0, $tail) } catch { }
}

# --- staging cleanup -----------------------------------------------------

function _Ui-TrackStaging($p) {
  [void]$script:UiStagingPaths.Add($p)
}

function _Ui-CleanupStaging {
  foreach ($p in $script:UiStagingPaths) {
    if (Test-Path $p) {
      Remove-Item -Force $p -ErrorAction SilentlyContinue
    }
  }
  $script:UiStagingPaths.Clear()
}

function _Ui-Cleanup {
  _Ui-CleanupStaging
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
  }
}

# --- public surface ------------------------------------------------------

# Ui-Init "TITLE" -- emit the title block; hide cursor; save top row.
function Ui-Init($Title) {
  Write-Host ""
  Write-Host "  $Title"
  Write-Host ""
  if ($script:UiTty) {
    try {
      $script:UiTopRow = [Console]::CursorTop
      [Console]::CursorVisible = $false
    } catch {
      # Non-interactive host that pretended to be a TTY -- degrade.
      $script:UiTty = $false
    }
  }
  $script:UiCleanupInstalled = $true
}

# Ui-ActionAdd "LABEL" -- register a pending row; return the row index.
function Ui-ActionAdd($Label) {
  $idx = $script:UiRowsTotal
  $script:UiLabels += $Label
  $script:UiRowsTotal = $script:UiRowsTotal + 1
  $text = _Ui-FormatRow $script:UiGlyphPend $Label $null
  Write-Host $text
  return $idx
}

# Ui-ActionStart -Idx N -Label "LABEL" [-Suffix "(0/3)"]
function Ui-ActionStart($Idx, $Label, $Suffix) {
  $script:UiCurrent = $Idx
  $script:UiCurrentLabel = $Label
  $script:UiCurrentSuffix = $Suffix
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $script:UiGlyphDoing $null $Label $Suffix
  } else {
    _Ui-EmitRow $script:UiGlyphDoing $null $Label $Suffix
  }
}

# Ui-ActionUpdate -Idx N -Suffix "(2/3)" -- mutate the in-flight row.
function Ui-ActionUpdate($Idx, $Suffix) {
  $script:UiCurrentSuffix = $Suffix
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $script:UiGlyphDoing $null $script:UiCurrentLabel $Suffix
  } else {
    _Ui-EmitRow $script:UiGlyphDoing $null $script:UiCurrentLabel $Suffix
  }
}

function _Ui-Finalize($Idx, $Glyph, $Color, $Detail) {
  $label = $script:UiLabels[$Idx]
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $Glyph $Color $label $Detail
  } else {
    _Ui-EmitRow $Glyph $Color $label $Detail
  }
  $script:UiCurrent = -1
  $script:UiCurrentLabel = ""
  $script:UiCurrentSuffix = ""
}

function Ui-ActionDone($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphDone "Green" $Detail
}

function Ui-ActionSkip($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphSkip "Green" $Detail
}

function Ui-ActionError($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphErr "Red" $Detail
}

# Ui-Finish -Lines @("Pairing code: X", "", "Open ...")
function Ui-Finish($Lines) {
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
    # Make sure we're below the last row so the footer doesn't overwrite UI.
    try { [Console]::SetCursorPosition(0, $script:UiTopRow + $script:UiRowsTotal) } catch { }
  }
  Write-Host ""
  foreach ($line in $Lines) {
    if (-not $line) {
      Write-Host ""
    } else {
      Write-Host "  $line"
    }
  }
  Write-Host ""
}

# Ui-Die "REASON" ["DETAIL"] ["HINT"]
# Flip current row to [x] (red), print structured error block, exit 1.
function Ui-Die($Reason, $Detail, $Hint) {
  if ($script:UiCurrent -ge 0) {
    _Ui-Finalize $script:UiCurrent $script:UiGlyphErr "Red" $Reason
  }
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
    try { [Console]::SetCursorPosition(0, $script:UiTopRow + $script:UiRowsTotal) } catch { }
  }
  # Error block on stderr; emit in one stream so colored prefix and message
  # stay ordered. Write-Host -ForegroundColor only colors host (stdout) text,
  # so we use a plain stderr write here.
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("error: $Reason")
  if ($Detail) {
    [Console]::Error.WriteLine("       $Detail")
  }
  if ($Hint) {
    [Console]::Error.WriteLine("hint:  $Hint")
  }
  [Console]::Error.WriteLine("")
  _Ui-Cleanup
  exit 1
}

# ===== UI helpers end =====

# Decompress a gzip file ($Src) to ($Dst). Core artifacts (binary, workers,
# helpers) ship gzip-compressed; the manifest sha256 is over the decompressed
# file, which the caller verifies. Uses the BCL GZipStream (no external tool).
function Expand-GzipFile($Src, $Dst) {
  $in = [System.IO.File]::OpenRead($Src)
  try {
    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [System.IO.File]::Create($Dst)
      try { $gz.CopyTo($out) } finally { $out.Dispose() }
    } finally { $gz.Dispose() }
  } finally { $in.Dispose() }
}

# --- configuration --------------------------------------------------------

$Storage = if ($env:TOMAT_STORAGE) { $env:TOMAT_STORAGE } else { "https://get.au.tomat.ing" }
# Install channel. Every channel lives under %USERPROFILE%\.tomat\<channel>\
# so dev / latest installs never collide with stable. Validate up front.
$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
# Per-channel naming + port (stable stays bare). Mirrors core.sh + the runtime
# side (paths.ts channelSuffix/corePort + config.ts manifestDir).
if ($Channel -eq "stable") {
  $ChannelSuffix = ""
  $ManifestDir = "manifests"
  $PortOffset = 0
} else {
  $ChannelSuffix = "-$Channel"
  $ManifestDir = "manifests/$Channel"
  $PortOffset = if ($Channel -eq "latest") { 10 } else { 20 }
}
$CorePort = 7800 + $PortOffset
$HomeDir = if ($env:TOMAT_CORE_HOME) { $env:TOMAT_CORE_HOME } else { Join-Path $HOME ".tomat\$Channel\core" }
$BinDir = Join-Path $HomeDir "bin"
$WorkersDir = Join-Path $HomeDir "workers"
$ExtensionsDir = Join-Path $HomeDir "extensions"
$StagingDir = Join-Path $HomeDir "staging"
$LogsDir = Join-Path $HomeDir "logs"
$ManifestUrl = "$Storage/$ManifestDir/core.json"
$InstallService = if ($env:TOMAT_INSTALL_SERVICE) { $env:TOMAT_INSTALL_SERVICE } else { "1" }
$InstallBindAll = if ($env:TOMAT_INSTALL_BIND_ALL) { $env:TOMAT_INSTALL_BIND_ALL } else { "0" }
$InstallBehindProxy = if ($env:TOMAT_INSTALL_BEHIND_PROXY) { $env:TOMAT_INSTALL_BEHIND_PROXY } else { "0" }

# The admin token, settings, Scheduled Task, and process names are all owned by
# the core binary's install-service / mint-code subcommands now, so this script
# no longer derives them (mirrors the cleanup already done in core.sh).
$Installed = Join-Path $BinDir "tomat-core$ChannelSuffix.exe"

# Make sure the staging tree exists before any UI starts.
foreach ($d in @($BinDir, $WorkersDir, $ExtensionsDir, $StagingDir, $LogsDir)) {
  [void](New-Item -ItemType Directory -Force -Path $d)
}

# Service registration (Scheduled Task, or the background fallback) is chosen
# and performed by the core binary's install-service subcommand, so this script
# no longer builds a label or prompts for an admin password (the client sets it
# over the API after pairing; headless installs can set it later).

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat Core installer"

  # Register every row up front so the cursor knows the total height. The seed
  # binary is fetched + verified here; everything past it is delegated to the
  # core binary's install subcommands.
  #
  # Row labels are user-facing copy in two places at once: this terminal AND
  # the Client's install button, which tails the non-TTY transcript and shows
  # the active row's label with a running percentage (tomat-client
  # .../commands/pairing.rs). Keep them short, plain, and free of paths/URLs;
  # put specifics in the suffix or the stderr progress lines instead.
  $IdxHost     = Ui-ActionAdd "Checking this computer"
  $IdxManifest = Ui-ActionAdd "Finding the newest Core"
  $IdxBin      = Ui-ActionAdd "Downloading the Core"
  $IdxDeps     = Ui-ActionAdd "Installing helpers and workers"
  $IdxService  = Ui-ActionAdd "Starting the Core"
  $IdxPair     = Ui-ActionAdd "Getting a pairing code"

  # --- action 1: detect host ----------------------------------------------

  Ui-ActionStart $IdxHost "Checking this computer"

  if (-not [Environment]::Is64BitOperatingSystem) {
    Ui-Die "Unsupported OS or architecture" `
      "Detected: 32-bit Windows" `
      "tomat targets x86_64/aarch64 on Windows"
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
  $Triple = "$arch-pc-windows-msvc"

  Ui-ActionDone $IdxHost "($Triple)"

  # --- action 2: fetch manifest -------------------------------------------

  Ui-ActionStart $IdxManifest "Finding the newest Core"

  $manifest = $null
  try {
    $resp = Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing
    if (-not $resp.Content) {
      Ui-Die "Empty manifest from $ManifestUrl" `
        "" `
        "transient outage at R2; try again in a few minutes"
    }
    try {
      $manifest = $resp.Content | ConvertFrom-Json
    } catch {
      Ui-Die "Could not parse manifest JSON" `
        "" `
        "redirected or proxy interception?"
    }
  } catch {
    # PS 5.1: System.Net.WebException with .Response.StatusCode
    # PS 7+:  Microsoft.PowerShell.Commands.HttpResponseException with .Response.StatusCode
    $status = 0
    try {
      if ($_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
      }
    } catch { }
    if ($status -eq 404) {
      Ui-Die "Manifest not found at $ManifestUrl" `
        "HTTP 404" `
        "the storage origin may be misconfigured; report at github.com/rzkyif/tomat/issues"
    } elseif ($status -ge 500 -and $status -lt 600) {
      Ui-Die "Storage returned $status" `
        "" `
        "transient outage at R2; try again in a few minutes"
    } else {
      Ui-Die "Network error reaching get.au.tomat.ing" `
        $_.Exception.Message `
        "check internet connectivity, then re-run"
    }
  }

  if (-not $manifest.version) {
    Ui-Die "Manifest missing version field" `
      "" `
      "the storage origin may be misconfigured"
  }
  $entry = $manifest.binaries | Where-Object { $_.triple -eq $Triple } | Select-Object -First 1
  if (-not $entry) {
    Ui-Die "No binary for $Triple in manifest" `
      "" `
      "your platform may not be supported yet"
  }

  Ui-ActionDone $IdxManifest "(v$($manifest.version))"

  # --- action 3: install core binary --------------------------------------

  # Pre-check: does the on-disk binary already match?
  $ExistingOk = $false
  if (Test-Path $Installed) {
    try {
      $existingSha = (Get-FileHash -Algorithm SHA256 -Path $Installed).Hash.ToLowerInvariant()
      if ($existingSha -eq $entry.sha256.ToLowerInvariant()) {
        $ExistingOk = $true
      }
    } catch { }
  }

  if ($ExistingOk) {
    Ui-ActionSkip $IdxBin "(already current)"
  } else {
    Ui-ActionStart $IdxBin "Downloading the Core" "(downloading)"

    $BinTmp = Join-Path $StagingDir "tomat-core-$($manifest.version)-$([System.IO.Path]::GetRandomFileName()).exe"
    $BinGz = "$BinTmp.gz"
    _Ui-TrackStaging $BinTmp
    _Ui-TrackStaging $BinGz

    try {
      Invoke-WebRequest -Uri $entry.url -OutFile $BinGz -UseBasicParsing
    } catch {
      Ui-Die "Download interrupted" `
        "Invoke-WebRequest failed for $($entry.url): $($_.Exception.Message)" `
        "re-run; partial files were cleaned up"
    }

    # The artifact ships gzip-compressed; sha256 is over the decompressed binary.
    Ui-ActionUpdate $IdxBin "(decompressing)"
    try {
      Expand-GzipFile $BinGz $BinTmp
    } catch {
      Ui-Die "Could not decompress core binary" `
        "gzip decompress failed: $($_.Exception.Message)" `
        "network corruption is the usual cause; re-run"
    }
    Remove-Item -Force $BinGz -ErrorAction SilentlyContinue

    Ui-ActionUpdate $IdxBin "(verifying)"
    $got = (Get-FileHash -Algorithm SHA256 -Path $BinTmp).Hash.ToLowerInvariant()
    if ($got -ne $entry.sha256.ToLowerInvariant()) {
      Ui-Die "sha256 mismatch on core binary" `
        "want $($entry.sha256), got $got" `
        "network corruption is the usual cause; re-run"
    }

    Ui-ActionUpdate $IdxBin "(installing)"
    try {
      Move-Item -Force $BinTmp $Installed
    } catch [System.UnauthorizedAccessException] {
      Ui-Die "Permission denied writing to $BinDir\" `
        $_.Exception.Message `
        "check ownership of %USERPROFILE%\.tomat"
    } catch {
      Ui-Die "Could not install core binary" `
        "Move-Item failed: $($_.Exception.Message)" `
        "check disk space and ownership of $BinDir\"
    }

    $sizeMb = [int]((Get-Item $Installed).Length / 1MB)
    Ui-ActionDone $IdxBin "($sizeMb MB)"
  }

  # --- deps + service + pairing (delegated to the core binary) ------------
  #
  # Everything past the seed binary is the core binary's own responsibility now
  # (packages/tomat-core/src/install): self-install fetches + verifies the
  # workers + helpers, install-service writes the admin token / optional
  # bind-all / built-in extension and registers the Scheduled Task, and
  # mint-code prints the first pairing code as JSON. TOMAT_CHANNEL /
  # TOMAT_INSTALL_SERVICE / TOMAT_INSTALL_BIND_ALL / TOMAT_INSTALL_BEHIND_PROXY
  # flow through the environment.

  # The subcommand calls below are BARE on purpose: no pipeline, no capture, no
  # redirection (the PowerShell mirror of core.sh's plain `>&2`). The core's
  # install subcommands print progress to stderr and keep stdout clean, so a
  # pipe would relay nothing anyway; worse, ANY PowerShell read of the
  # subcommand's stdout hangs the TOMAT_INSTALL_SERVICE=0 path forever. Every
  # spawn hop on Windows passes bInheritHandles, so the detached core that
  # install-service leaves running inherits the pipe's write end, and the
  # read-to-EOF never completes even after the subcommand exits (the client
  # then sits at "Starting the Core (67%)" until its 45-minute cap). A bare
  # call hands the child this script's own stdout/stderr handles (console or
  # file, neither of which blocks on an open inherited copy), and
  # $LASTEXITCODE still reports the subcommand's exit.

  Ui-ActionStart $IdxDeps "Installing helpers and workers"
  $env:TOMAT_CHANNEL = $Channel
  & $Installed self-install
  if ($LASTEXITCODE -ne 0) {
    Ui-Die "Failed to install helpers and workers" "" "re-run; verification output is above"
  }
  Ui-ActionDone $IdxDeps

  Ui-ActionStart $IdxService "Starting the Core"
  $env:TOMAT_INSTALL_SERVICE = $InstallService
  $env:TOMAT_INSTALL_BIND_ALL = $InstallBindAll
  $env:TOMAT_INSTALL_BEHIND_PROXY = $InstallBehindProxy
  & $Installed install-service
  if ($LASTEXITCODE -ne 0) {
    Ui-Die "Failed to start the Core" "" "re-run with TOMAT_INSTALL_SERVICE=0 to launch core without a service"
  }
  Ui-ActionDone $IdxService

  # --- mint the first pairing code ---------------------------------------

  Ui-ActionStart $IdxPair "Getting a pairing code" "(waiting for core)"
  # Capturing stdout here is safe despite the no-pipeline rule above: this pipe
  # is created AFTER the detached core was launched (so the core holds no copy
  # of its write end), and mint-code spawns nothing that outlives it.
  $code = ""
  try {
    $pairJson = & $Installed mint-code 2>$null
    if ($pairJson) {
      $code = ($pairJson | ConvertFrom-Json).code
    }
  } catch { }
  if ($code) {
    Ui-ActionDone $IdxPair
  } else {
    Ui-ActionSkip $IdxPair "(could not mint; see manual instructions below)"
  }

  # --- footer ------------------------------------------------------------

  # The "Pairing code:" line is parsed by the client's install trampoline
  # (tomat-client .../commands/pairing.rs parse_pairing_code); keep the prefix.
  if ($code) {
    Ui-Finish @(
      "Pairing code: $code",
      "",
      "Open a tomat Client, choose to pair with a Core on another computer,",
      "and enter:",
      "  URL : https://127.0.0.1:$CorePort   (or this host's LAN IP)",
      "  Code: $code"
    )
  } else {
    Ui-Finish @(
      "The Core is installed. Get a pairing code with:",
      "  & '$Installed' mint-code"
    )
  }

  exit 0
}
finally {
  _Ui-Cleanup
}
