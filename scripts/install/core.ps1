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
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*] (no spinner on Windows -- Start-Job overhead is significant;
#   loops mutate the suffix instead), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   Windows 10 1809+ and Windows 11 (UTF-8 capable conhost / Terminal).

$ErrorActionPreference = "Stop"

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
$ToolkitsDir = Join-Path $HomeDir "toolkits"
$StagingDir = Join-Path $HomeDir "staging"
$LogsDir = Join-Path $HomeDir "logs"
$ManifestUrl = "$Storage/$ManifestDir/core.json"
$InstallService = if ($env:TOMAT_INSTALL_SERVICE) { $env:TOMAT_INSTALL_SERVICE } else { "1" }
$InstallBindAll = if ($env:TOMAT_INSTALL_BIND_ALL) { $env:TOMAT_INSTALL_BIND_ALL } else { "0" }

$AdminTokenFile = Join-Path $HomeDir ".admin-token"
$SettingsFile = Join-Path $HomeDir "settings.json"
$Installed = Join-Path $BinDir "tomat-core$ChannelSuffix.exe"
# Scheduled-task name + process name, suffixed per channel so channels coexist.
$TaskName = "tomat-core$ChannelSuffix"
$ProcName = "tomat-core$ChannelSuffix"

# Make sure the staging tree exists before any UI starts.
foreach ($d in @($BinDir, $WorkersDir, $ToolkitsDir, $StagingDir, $LogsDir)) {
  [void](New-Item -ItemType Directory -Force -Path $d)
}

# --- pick the service label up front --------------------------------------

if ($InstallService -eq "1") {
  $ServiceLabel = "Registering Windows scheduled task '$TaskName'"
} else {
  $ServiceLabel = "Starting core in background (Start-Process)"
}

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat-core installer"

  # Register every row up front so the cursor knows the total height. The
  # settings.json row is conditional on TOMAT_INSTALL_BIND_ALL=1.
  $IdxHost     = Ui-ActionAdd "Detecting host"
  $IdxManifest = Ui-ActionAdd "Fetching manifest from get.au.tomat.ing"
  $IdxBin      = Ui-ActionAdd "Installing core binary to $Installed"
  $IdxWorkers  = Ui-ActionAdd "Installing workers to $WorkersDir\"
  $IdxHelpers  = Ui-ActionAdd "Installing helpers to $BinDir\"
  # Built-in toolkit is CDN-distributed for stable/latest; dev sources it from the
  # codebase at runtime, so there's nothing to fetch here.
  $IdxToolkit  = -1
  if ($Channel -ne "dev") {
    $IdxToolkit = Ui-ActionAdd "Installing built-in toolkit to $ToolkitsDir\"
  }
  $IdxToken    = Ui-ActionAdd "Writing admin token to $AdminTokenFile"
  $IdxSettings = -1
  if ($InstallBindAll -eq "1") {
    $IdxSettings = Ui-ActionAdd "Seeding $SettingsFile"
  }
  $IdxService = Ui-ActionAdd $ServiceLabel
  $IdxPair    = Ui-ActionAdd "Minting pairing code at https://127.0.0.1:$CorePort"

  # --- action 1: detect host ----------------------------------------------

  Ui-ActionStart $IdxHost "Detecting host"

  if (-not [Environment]::Is64BitOperatingSystem) {
    Ui-Die "Unsupported OS or architecture" `
      "Detected: 32-bit Windows" `
      "tomat targets x86_64/aarch64 on Windows"
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
  $Triple = "$arch-pc-windows-msvc"

  Ui-ActionDone $IdxHost "($Triple)"

  # --- action 2: fetch manifest -------------------------------------------

  Ui-ActionStart $IdxManifest "Fetching manifest from get.au.tomat.ing"

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
        "the storage origin may be misconfigured; report at github.com/<repo>/issues"
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
    Ui-ActionStart $IdxBin "Installing core binary to $Installed" "(downloading)"

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

  # --- action 4: install workers ------------------------------------------

  $workers = @()
  if ($manifest.workers) {
    $workers = @($manifest.workers)
  }
  $workersCount = $workers.Count

  # Pre-check: are all workers already on disk and matching?
  $workersAllOk = $true
  if ($workersCount -gt 0) {
    foreach ($w in $workers) {
      $wPath = Join-Path $WorkersDir $w.name
      if (-not (Test-Path $wPath)) { $workersAllOk = $false; break }
      try {
        $wGot = (Get-FileHash -Algorithm SHA256 -Path $wPath).Hash.ToLowerInvariant()
      } catch { $workersAllOk = $false; break }
      if ($wGot -ne $w.sha256.ToLowerInvariant()) { $workersAllOk = $false; break }
    }
  }

  if ($workersAllOk) {
    Ui-ActionSkip $IdxWorkers "($workersCount/$workersCount already current)"
  } else {
    Ui-ActionStart $IdxWorkers "Installing workers to $WorkersDir\" "(0/$workersCount)"

    $i = 0
    foreach ($w in $workers) {
      $wPath = Join-Path $WorkersDir $w.name

      # Skip individual workers that are already correct on disk.
      $wNeed = $true
      if (Test-Path $wPath) {
        try {
          $wGot = (Get-FileHash -Algorithm SHA256 -Path $wPath).Hash.ToLowerInvariant()
          if ($wGot -eq $w.sha256.ToLowerInvariant()) { $wNeed = $false }
        } catch { }
      }

      $i = $i + 1
      Ui-ActionUpdate $IdxWorkers "($i/$workersCount $($w.name))"

      if ($wNeed) {
        $wTmp = Join-Path $StagingDir "$($w.name)-$($manifest.version)-$([System.IO.Path]::GetRandomFileName())"
        $wGz = "$wTmp.gz"
        _Ui-TrackStaging $wTmp
        _Ui-TrackStaging $wGz

        try {
          Invoke-WebRequest -Uri $w.url -OutFile $wGz -UseBasicParsing
        } catch {
          Ui-Die "Download interrupted" `
            "fetching worker $($w.name): $($_.Exception.Message)" `
            "re-run; partial files were cleaned up"
        }

        try {
          Expand-GzipFile $wGz $wTmp
        } catch {
          Ui-Die "Could not decompress worker $($w.name)" `
            "gzip decompress failed: $($_.Exception.Message)" `
            "network corruption is the usual cause; re-run"
        }
        Remove-Item -Force $wGz -ErrorAction SilentlyContinue

        $wGot = (Get-FileHash -Algorithm SHA256 -Path $wTmp).Hash.ToLowerInvariant()
        if ($wGot -ne $w.sha256.ToLowerInvariant()) {
          Ui-Die "sha256 mismatch on worker $($w.name)" `
            "want $($w.sha256), got $wGot" `
            "network corruption is the usual cause; re-run"
        }

        try {
          Move-Item -Force $wTmp $wPath
        } catch {
          Ui-Die "Permission denied writing to $WorkersDir\" `
            "could not install $($w.name): $($_.Exception.Message)" `
            "check ownership of %USERPROFILE%\.tomat"
        }
      }
    }

    Ui-ActionDone $IdxWorkers "($workersCount/$workersCount)"
  }

  # --- action 5: install helpers ------------------------------------------

  $helpers = @()
  if ($manifest.helpers) {
    $helpers = @($manifest.helpers | Where-Object { $_.triple -eq $Triple })
  }
  $helpersMatching = $helpers.Count

  if ($helpersMatching -eq 0) {
    Ui-ActionSkip $IdxHelpers "(no helper for this triple)"
  } else {
    # Pre-check: every matching helper already correct?
    $helpersAllOk = $true
    foreach ($h in $helpers) {
      $hFilename = "$($h.name).exe"
      $hPath = Join-Path $BinDir $hFilename
      if (-not (Test-Path $hPath)) { $helpersAllOk = $false; break }
      try {
        $hGot = (Get-FileHash -Algorithm SHA256 -Path $hPath).Hash.ToLowerInvariant()
      } catch { $helpersAllOk = $false; break }
      if ($hGot -ne $h.sha256.ToLowerInvariant()) { $helpersAllOk = $false; break }
    }

    if ($helpersAllOk) {
      Ui-ActionSkip $IdxHelpers "($helpersMatching/$helpersMatching already current)"
    } else {
      Ui-ActionStart $IdxHelpers "Installing helpers to $BinDir\" "(0/$helpersMatching)"

      $j = 0
      foreach ($h in $helpers) {
        $hFilename = "$($h.name).exe"
        $hPath = Join-Path $BinDir $hFilename

        $hNeed = $true
        if (Test-Path $hPath) {
          try {
            $hGot = (Get-FileHash -Algorithm SHA256 -Path $hPath).Hash.ToLowerInvariant()
            if ($hGot -eq $h.sha256.ToLowerInvariant()) { $hNeed = $false }
          } catch { }
        }

        $j = $j + 1
        Ui-ActionUpdate $IdxHelpers "($j/$helpersMatching $hFilename)"

        if ($hNeed) {
          $hTmp = Join-Path $StagingDir "$hFilename-$($manifest.version)-$([System.IO.Path]::GetRandomFileName())"
          $hGz = "$hTmp.gz"
          _Ui-TrackStaging $hTmp
          _Ui-TrackStaging $hGz

          try {
            Invoke-WebRequest -Uri $h.url -OutFile $hGz -UseBasicParsing
          } catch {
            Ui-Die "Download interrupted" `
              "fetching helper $hFilename: $($_.Exception.Message)" `
              "re-run; partial files were cleaned up"
          }

          try {
            Expand-GzipFile $hGz $hTmp
          } catch {
            Ui-Die "Could not decompress helper $hFilename" `
              "gzip decompress failed: $($_.Exception.Message)" `
              "network corruption is the usual cause; re-run"
          }
          Remove-Item -Force $hGz -ErrorAction SilentlyContinue

          $hGot = (Get-FileHash -Algorithm SHA256 -Path $hTmp).Hash.ToLowerInvariant()
          if ($hGot -ne $h.sha256.ToLowerInvariant()) {
            Ui-Die "sha256 mismatch on helper $hFilename" `
              "want $($h.sha256), got $hGot" `
              "network corruption is the usual cause; re-run"
          }

          try {
            Move-Item -Force $hTmp $hPath
          } catch {
            Ui-Die "Permission denied writing to $BinDir\" `
              "could not install $hFilename: $($_.Exception.Message)" `
              "check ownership of %USERPROFILE%\.tomat"
          }
        }
      }

      Ui-ActionDone $IdxHelpers "($helpersMatching/$helpersMatching)"
    }
  }

  # --- action 5b: built-in toolkit ---------------------------------------
  # Download + extract the CDN-distributed built-in toolkit so a fresh core has
  # it out of the box. Core registers + activates it on first boot; if this is
  # skipped (manifest not yet published), core seeds it then.

  if ($IdxToolkit -ne -1) {
    $tkDir = Join-Path $ToolkitsDir "tomat-builtin-toolkit"
    if (Test-Path (Join-Path $tkDir "tools.json")) {
      Ui-ActionSkip $IdxToolkit "(already present)"
    } else {
      $tkManifest = $null
      try {
        $tkResp = Invoke-WebRequest -Uri "$Storage/$ManifestDir/toolkit.json" -UseBasicParsing
        $tkManifest = $tkResp.Content | ConvertFrom-Json
      } catch {
        $tkManifest = $null
      }
      if (-not $tkManifest -or -not $tkManifest.tarballUrl -or -not $tkManifest.sha256) {
        # Non-fatal: core seeds the built-in on first boot if this is missing.
        Ui-ActionSkip $IdxToolkit "(manifest unavailable; core will seed)"
      } else {
        Ui-ActionStart $IdxToolkit "Installing built-in toolkit to $ToolkitsDir\" "(downloading)"
        $tkTmp = Join-Path $StagingDir "builtin-toolkit-$([System.IO.Path]::GetRandomFileName()).tgz"
        try {
          Invoke-WebRequest -Uri $tkManifest.tarballUrl -OutFile $tkTmp -UseBasicParsing
        } catch {
          Ui-Die "Download interrupted" `
            "Invoke-WebRequest failed for $($tkManifest.tarballUrl): $($_.Exception.Message)" `
            "re-run; partial files were cleaned up"
        }
        $tkGot = (Get-FileHash -Algorithm SHA256 -Path $tkTmp).Hash.ToLowerInvariant()
        if ($tkGot -ne $tkManifest.sha256.ToLowerInvariant()) {
          Ui-Die "sha256 mismatch on built-in toolkit" `
            "want $($tkManifest.sha256), got $tkGot" `
            "network corruption is the usual cause; re-run"
        }
        Ui-ActionUpdate $IdxToolkit "(extracting)"
        if (Test-Path $tkDir) { Remove-Item -Recurse -Force $tkDir }
        [void](New-Item -ItemType Directory -Force -Path $tkDir)
        # tar.exe (bsdtar) ships with Windows 10+ and handles .tgz.
        & tar.exe -xzf $tkTmp -C $tkDir
        if ($LASTEXITCODE -ne 0) {
          Ui-Die "Could not extract built-in toolkit" `
            "tar.exe exited $LASTEXITCODE" `
            "re-run; check permissions under $ToolkitsDir\"
        }
        Remove-Item -Force $tkTmp -ErrorAction SilentlyContinue
        Ui-ActionDone $IdxToolkit "(installed)"
      }
    }
  }

  # --- action 6: admin token ---------------------------------------------

  $tokenPresent = $false
  if (Test-Path $AdminTokenFile) {
    if ((Get-Item $AdminTokenFile).Length -gt 0) {
      $tokenPresent = $true
    }
  }

  if ($tokenPresent) {
    Ui-ActionSkip $IdxToken "(already present)"
  } else {
    Ui-ActionStart $IdxToken "Writing admin token to $AdminTokenFile"

    try {
      $bytes = New-Object byte[] 16
      [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $hex = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    } catch {
      Ui-Die "No entropy source available" `
        $_.Exception.Message `
        "extremely rare; reboot and re-run"
    }

    try {
      Set-Content -Path $AdminTokenFile -Value $hex -NoNewline -Encoding ascii
    } catch {
      Ui-Die "Permission denied writing $AdminTokenFile" `
        $_.Exception.Message `
        "check ownership of $HomeDir\"
    }

    try {
      $acl = Get-Acl $AdminTokenFile
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
        "FullControl", "Allow")
      $acl.SetAccessRule($rule)
      Set-Acl -Path $AdminTokenFile -AclObject $acl
    } catch {
      Ui-Die "Failed to set ACL on .admin-token" `
        $_.Exception.Message `
        "the file was written but is world-readable; remove it and re-run"
    }

    Ui-ActionDone $IdxToken "(owner-only ACL)"
  }

  # --- action 6b: seed settings.json -------------------------------------

  if ($IdxSettings -ne -1) {
    if (Test-Path $SettingsFile) {
      Ui-ActionSkip $IdxSettings "(already present)"
    } else {
      Ui-ActionStart $IdxSettings "Seeding $SettingsFile"
      try {
        Set-Content -Path $SettingsFile -Value '{"server.bindHost":"0.0.0.0"}' -Encoding ascii
      } catch {
        Ui-Die "Permission denied writing $SettingsFile" `
          $_.Exception.Message `
          "check ownership of $HomeDir\"
      }
      Ui-ActionDone $IdxSettings "(server.bindHost=0.0.0.0)"
    }
  }

  # --- action 7: service registration ------------------------------------

  # Snapshot whether the core was already running before we touch anything,
  # so we can settle the row as [~] when nothing user-visible changed.
  $ServiceAlreadyRunning = $null -ne (Get-Process -Name $ProcName -ErrorAction SilentlyContinue)

  if ($InstallService -ne "1") {
    # Background branch -- no scheduled task.
    Ui-ActionStart $IdxService "Starting core in background (Start-Process)"
    try {
      $proc = Start-Process -FilePath $Installed -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogsDir "core.stdout.log") `
        -RedirectStandardError (Join-Path $LogsDir "core.stderr.log") `
        -PassThru
      Ui-ActionDone $IdxService "(pid $($proc.Id))"
    } catch {
      Ui-Die "Could not launch core in background" `
        $_.Exception.Message `
        "re-run with TOMAT_INSTALL_SERVICE=1 to register a scheduled task instead"
    }
  } else {
    # Scheduled task branch.
    Ui-ActionStart $IdxService "Registering Windows scheduled task '$TaskName'"

    # Check whether the existing task already points at the same binary.
    $TaskUnchanged = $false
    try {
      $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($existing -and $existing.Actions -and $existing.Actions[0].Execute -eq $Installed) {
        $TaskUnchanged = $true
      }
    } catch { }

    try {
      # Bake the channel into the task so the daemon resolves the same
      # ~/.tomat/<channel>. Scheduled tasks have no env field, so for
      # non-stable channels wrap the launch in cmd.exe to set TOMAT_CHANNEL.
      if ($Channel -eq "stable") {
        $action = New-ScheduledTaskAction -Execute $Installed
      } else {
        $action = New-ScheduledTaskAction -Execute "cmd.exe" `
          -Argument ("/c set TOMAT_CHANNEL={0}&& `"{1}`"" -f $Channel, $Installed)
      }
      $trigger = New-ScheduledTaskTrigger -AtLogOn
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
          -RestartCount 5 -RestartInterval (New-TimeSpan -Seconds 30) -AllowStartIfOnBatteries
      $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description "tomat-core" | Out-Null
      Start-ScheduledTask -TaskName $TaskName
    } catch {
      Ui-Die "Could not register scheduled task" `
        $_.Exception.Message `
        "Task Scheduler service may be disabled; re-run with TOMAT_INSTALL_SERVICE=0"
    }

    if ($TaskUnchanged -and $ServiceAlreadyRunning) {
      Ui-ActionSkip $IdxService "(reloaded)"
    } elseif ($TaskUnchanged) {
      Ui-ActionDone $IdxService "(started)"
    } else {
      Ui-ActionDone $IdxService "(registered)"
    }
  }

  # --- action 8: mint pairing code ---------------------------------------

  Ui-ActionStart $IdxPair "Minting pairing code at https://127.0.0.1:$CorePort" "(waiting for core)"

  Start-Sleep -Seconds 2

  $admin = $null
  try {
    $admin = Get-Content -Raw -Path $AdminTokenFile
  } catch { }

  # Core serves HTTPS with a self-signed cert. This mint runs on the core host
  # over loopback and is authenticated by the admin token, so skipping cert
  # verification here is fine; the client pins the cert during pairing.
  # -SkipCertificateCheck is PowerShell 6+; on Windows PowerShell 5.1 fall back
  # to the process-wide validation callback.
  $irmExtra = @{}
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    $irmExtra['SkipCertificateCheck'] = $true
  } else {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  }

  $code = $null
  $pairFailed = $true
  if ($admin) {
    try {
      $resp = Invoke-RestMethod -Method Post `
        -Uri "https://127.0.0.1:$CorePort/api/v1/pairing/codes" `
        -Headers @{ "X-Admin-Token" = $admin; "Content-Type" = "application/json" } `
        -Body "{}" @irmExtra
      if ($resp.code) {
        $code = $resp.code
        $pairFailed = $false
      }
    } catch { }
  }

  if (-not $pairFailed) {
    Ui-ActionDone $IdxPair
  } else {
    Ui-ActionSkip $IdxPair "(could not mint; see manual instructions below)"
  }

  # --- footer ------------------------------------------------------------

  if (-not $pairFailed) {
    Ui-Finish @(
      "Pairing code: $code",
      "",
      "Open tomat-client -> Pair -> enter:",
      "  URL : https://127.0.0.1:$CorePort   (or this host's LAN IP)",
      "  Code: $code"
    )
  } else {
    Ui-Finish @(
      "tomat-core installed. Mint a pairing code with:",
      "  `$admin = Get-Content -Raw '$AdminTokenFile'",
      "  Invoke-RestMethod -Method Post -Uri https://127.0.0.1:$CorePort/api/v1/pairing/codes ``",
      "    -SkipCertificateCheck ``",
      "    -Headers @{ 'X-Admin-Token' = `$admin; 'Content-Type' = 'application/json' } -Body '{}'"
    )
  }

  exit 0
}
finally {
  _Ui-Cleanup
}
