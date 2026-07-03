# tomat-client installer for Windows.
#
# Detects the host triple, fetches client.json from the storage origin,
# picks the per-user NSIS installer (.exe) for x86_64-pc-windows-msvc (or
# aarch64), downloads it to %TEMP%, verifies its sha256 against the manifest,
# strips the Mark of the Web (MOTW) attribute so SmartScreen doesn't show the
# "Windows protected your PC" warning, then runs it silently. The NSIS bundle is
# built currentUser (installMode in tauri.conf.json), so it installs under
# %LOCALAPPDATA% with NO administrator prompt.
#
# Trust model (read before pinning a vendor signing key here):
#   1. The installer is fetched over TLS from $env:TOMAT_STORAGE
#      (get.au.tomat.ing by default). Connection-level integrity is HTTPS.
#   2. The manifest at $env:TOMAT_STORAGE/manifests/client.json is fetched
#      over HTTPS. Its Ed25519 signature is NOT verified here: PowerShell ships
#      no minisign tool by default and pulling one in would inflate the install
#      surface. The installer is also NOT Authenticode-signed (tomat has no
#      Windows code-signing certificate yet); the currentUser NSIS package
#      avoids the "unknown publisher" elevation prompt a per-machine install
#      would trigger, since it needs no admin rights at all.
#   3. As defense-in-depth the downloaded .exe's sha256 is compared against the
#      manifest value (matching client.sh), so a corrupt or truncated download
#      is rejected. This does NOT stop a MITM that rewrites both the manifest
#      and the binary on the TLS origin; the in-app updater closes that gap by
#      verifying the signed manifest inside the running client on every
#      subsequent update.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/client.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_STORAGE  override storage base URL (default: https://get.au.tomat.ing)
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*] (no spinner on Windows), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   Windows 10 1809+ and Windows 11 (UTF-8 capable conhost / Terminal).

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (the `powershell.exe` this one-liner runs under) redraws
# the Invoke-WebRequest progress bar on every socket read, throttling -OutFile
# downloads to a fraction of the link speed. Suppressing progress restores full
# throughput on the multi-tens-of-MB NSIS installer.
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

# --- configuration --------------------------------------------------------

$Storage = if ($env:TOMAT_STORAGE) { $env:TOMAT_STORAGE } else { "https://get.au.tomat.ing" }
# Install channel via TOMAT_CHANNEL env. A latest client is a distinct app
# (tomat-latest, identifier au.tomat.ing.latest) that coexists with stable and
# updates from the latest manifest. The NSIS installer itself controls the
# install dir + product name (baked by build-client.ts); this script just picks
# the channel manifest + display strings.
$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
if ($Channel -eq "stable") {
  $ManifestDir = "manifests"
  $DisplayName = "tomat"
  $InstallDirName = "tomat"
} else {
  $ManifestDir = "manifests/$Channel"
  $DisplayName = if ($Channel -eq "latest") { "tomat (latest)" } else { "tomat (dev)" }
  $InstallDirName = "tomat-$Channel"
}
$ManifestUrl = "$Storage/$ManifestDir/client.json"

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat-client installer"

  $IdxHost     = Ui-ActionAdd "Detecting host"
  $IdxDownload = Ui-ActionAdd "Downloading installer to %TEMP%"
  $IdxVerify   = Ui-ActionAdd "Verifying download (sha256)"
  $IdxMotw     = Ui-ActionAdd "Clearing Mark of the Web"
  $IdxInstall  = Ui-ActionAdd "Installing $DisplayName (per-user, no admin prompt)"
  # NSIS names every shortcut after the baked productName ($InstallDirName), so a
  # non-stable channel needs a rename pass to show the friendly $DisplayName.
  # Stable's productName already equals its DisplayName, so it needs no pass.
  $IdxShortcut = -1
  if ($Channel -ne "stable") {
    $IdxShortcut = Ui-ActionAdd "Renaming shortcuts to `"$DisplayName`""
  }

  # --- action 1: detect host ----------------------------------------------

  Ui-ActionStart $IdxHost "Detecting host"

  if (-not [Environment]::Is64BitOperatingSystem) {
    Ui-Die "Unsupported OS" `
      "32-bit Windows is not supported" `
      "tomat targets 64-bit Windows"
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
  $Triple = "$arch-pc-windows-msvc"
  # client.json is the Tauri updater endpoint, so its `platforms` map is keyed in
  # Tauri's `<os>-<arch>` format (windows-x86_64, windows-aarch64), NOT the Rust
  # triple. Match tauriPlatformKey() in scripts/release/client.ts.
  $PlatformKey = "windows-$arch"

  Ui-ActionDone $IdxHost "($Triple)"

  # --- action 2: download installer ---------------------------------------

  Ui-ActionStart $IdxDownload "Downloading installer to %TEMP%" "(fetching manifest)"

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
  $entry = $manifest.platforms.$PlatformKey
  if (-not $entry -or -not $entry.url) {
    Ui-Die "No client artifact for $PlatformKey in manifest" `
      "" `
      "your platform may not be supported yet"
  }

  # Stable, friendly filename (not a random temp name): this is what any
  # SmartScreen / antivirus prompt shows the user, so it should read as tomat's.
  $Tmp = Join-Path $env:TEMP "$InstallDirName-setup.exe"
  _Ui-TrackStaging $Tmp

  Ui-ActionUpdate $IdxDownload "(downloading v$($manifest.version))"

  try {
    Invoke-WebRequest -Uri $entry.url -OutFile $Tmp -UseBasicParsing
  } catch {
    Ui-Die "Download interrupted" `
      "Invoke-WebRequest failed for $($entry.url): $($_.Exception.Message)" `
      "re-run; partial files were cleaned up"
  }

  $sizeMb = [int]((Get-Item $Tmp).Length / 1MB)
  Ui-ActionDone $IdxDownload "($sizeMb MB)"

  # --- action 3: verify sha256 -------------------------------------------

  # Matches client.sh: reject a corrupt or truncated download before running it.
  # (The manifest's Ed25519 signature is not checked here; see the trust model
  # in the header.)
  if (-not $entry.sha256) {
    Ui-ActionSkip $IdxVerify "(no sha256 in manifest)"
  } else {
    Ui-ActionStart $IdxVerify "Verifying download (sha256)"
    $actualSha = (Get-FileHash -Path $Tmp -Algorithm SHA256).Hash.ToLower()
    if ($actualSha -ne $entry.sha256.ToLower()) {
      Ui-Die "Downloaded installer failed sha256 verification" `
        "expected $($entry.sha256), got $actualSha" `
        "the download may be corrupt or tampered; re-run"
    }
    Ui-ActionDone $IdxVerify "(ok)"
  }

  # --- action 4: clear Mark of the Web -----------------------------------

  $motwPresent = $null -ne (Get-Item -Path $Tmp -Stream Zone.Identifier -ErrorAction SilentlyContinue)

  if (-not $motwPresent) {
    Ui-ActionSkip $IdxMotw "(no MOTW present)"
  } else {
    Ui-ActionStart $IdxMotw "Clearing Mark of the Web"
    $motwCleared = $true
    try {
      Unblock-File -Path $Tmp -ErrorAction Stop
    } catch {
      $motwCleared = $false
    }
    if ($motwCleared) {
      Ui-ActionDone $IdxMotw "(cleared)"
    } else {
      Ui-ActionDone $IdxMotw "(MOTW could not be cleared)"
    }
  }

  # --- action 5: install via NSIS (silent, per-user) ---------------------

  Ui-ActionStart $IdxInstall "Installing $DisplayName (per-user, no admin prompt)"

  $proc = $null
  try {
    # /S = NSIS silent install. The bundle's currentUser installMode means no
    # elevation is requested; the app lands under %LOCALAPPDATA% with a Start
    # Menu shortcut. Start-Process -Wait blocks until the installer finishes.
    $proc = Start-Process -FilePath $Tmp -ArgumentList "/S" -Wait -PassThru
  } catch {
    Ui-Die "Could not launch the installer" `
      $_.Exception.Message `
      "the download may be blocked by SmartScreen or antivirus; re-run"
  }

  $code = $proc.ExitCode
  if ($code -eq 0) {
    Ui-ActionDone $IdxInstall "(installed)"
  } else {
    Ui-Die "Installer exited with code $code" `
      "" `
      "quit any running tomat and re-run; if it persists, report at github.com/rzkyif/tomat/issues"
  }

  # --- action 6: friendly-name the shortcuts -----------------------------

  # NSIS names the per-user Start Menu and desktop .lnk files after the baked
  # productName ($InstallDirName, e.g. "tomat-latest"), but users should see the
  # channel's friendly $DisplayName ("tomat (latest)"). Rename them in place, the
  # Windows parallel to the macOS installer renaming the .app. In-app updates run
  # the NSIS installer with /UPDATE, which skips shortcut (re)creation, so the
  # friendly names persist. Re-running this script recreates the productName-named
  # .lnk and this pass renames it again (idempotent via -Force overwrite).
  if ($Channel -ne "stable") {
    Ui-ActionStart $IdxShortcut "Renaming shortcuts to `"$DisplayName`""
    $ShortcutDirs = @(
      [Environment]::GetFolderPath("Programs"),
      [Environment]::GetFolderPath("Desktop")
    )
    foreach ($dir in $ShortcutDirs) {
      $src = Join-Path $dir "$InstallDirName.lnk"
      $dst = Join-Path $dir "$DisplayName.lnk"
      if (Test-Path -LiteralPath $src) {
        Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
      }
    }
    Ui-ActionDone $IdxShortcut "(done)"
  }

  # --- footer ------------------------------------------------------------

  Ui-Finish @(
    "$DisplayName installed.",
    "",
    "Launch from the Start Menu (search for `"$DisplayName`")."
  )

  exit 0
}
finally {
  _Ui-Cleanup
}
