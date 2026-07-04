# tomat-client uninstaller for Windows.
#
# Finds the installed client via the Uninstall registry keys (HKCU first for
# the per-user NSIS install, then HKLM 64-bit / WOW6432Node for a legacy
# per-machine MSI) using a case-insensitive name match, then runs its NSIS
# uninstaller silently (msiexec /x kept as a fallback for an MSI install).
# The paired-core list under %USERPROFILE%\.tomat\<channel>\client\ is ALWAYS
# removed so a re-install starts clean and does not try to reach a Core that is
# gone. The rest of that dir (settings) is removed too by default; pass -KeepData
# to preserve just the settings.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/client-uninstall.ps1 | iex"
#   powershell -ExecutionPolicy Bypass -Command "& { $env:TOMAT_KEEP_DATA='1'; iwr -useb https://get.au.tomat.ing/install/client-uninstall.ps1 | iex }"
#
# Flags:
#   -KeepData             keep the settings in %USERPROFILE%\.tomat\<channel>\client\ (the paired-core list is still removed).
#   $env:TOMAT_KEEP_DATA  "1" is the env equivalent of -KeepData, for the piped one-liner above
#                         (a switch param can't be passed through `iwr | iex`).
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*], and rows settle into [x] (done), [~] (no-op skip), or [!]
#   (error). Glyphs upgrade to checkmark/cross on Windows 10 1809+ and
#   Windows 11 (UTF-8 capable conhost / Terminal).

param(
  [switch]$KeepData
)

$ErrorActionPreference = "Stop"

# The one-liner install path (`iwr ... | iex`) cannot pass the -KeepData switch,
# so honor $env:TOMAT_KEEP_DATA=1 as the documented equivalent.
if ($env:TOMAT_KEEP_DATA -in @("1", "true")) {
  $KeepData = $true
}

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

# Channel via TOMAT_CHANNEL env. Selects the channel's client state dir + the
# uninstall-registry DisplayName to match (tomat vs "tomat (latest)").
$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
$ClientDir = Join-Path $HOME ".tomat\$Channel\client"
# The paired-core list (and, on the dev channel, its file-backed tokens) is always
# removed so a re-install starts clean; -KeepData preserves only the settings.
$CoresJson = Join-Path $ClientDir "cores.json"
$KeychainJson = Join-Path $ClientDir "keychain.json"
# Match this channel's product only, keyed off the NSIS DisplayName (= Tauri
# productName; see build-client.ts). Stable is bare "tomat" (end, or followed by
# a version digit); non-stable is "tomat (<channel>)". The stable pattern stops
# at end-or-space-digit so it never matches the parenthesized non-stable names.
if ($Channel -eq "stable") {
  $ProductPattern = "^[Tt]omat($| \d)"
} else {
  $ProductPattern = "^[Tt]omat \($Channel\)"
}
# HKCU first: the per-user NSIS install registers there. HKLM entries remain for
# a legacy per-machine MSI install.
$UninstallKeys = @(
  "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
# On signed stable/latest builds the Client stores each paired core's bearer token
# in Windows Credential Manager (keyring-core windows-native-keyring-store) under
# service "tomat-client<suffix>", account "core:<coreId>" (mirrors the client's
# channel.rs + keychain.rs). The crate's Windows target name is "<account>.<service>",
# i.e. "core:<id>.tomat-client<suffix>". Dev keeps its tokens in keychain.json
# (removed with the data), so it needs no Credential Manager clearing.
if ($Channel -eq "stable") { $KeychainService = "tomat-client" }
else { $KeychainService = "tomat-client-$Channel" }

# Delete one Windows Credential Manager generic credential by target name via
# CredDeleteW (CRED_TYPE_GENERIC = 1). Matches keyring-core's delete_credential
# exactly and avoids cmdkey's ambiguous parsing of the embedded ":" in "core:<id>".
# Returns $true when the entry was deleted or was already absent (idempotent),
# $false on a real error.
Add-Type -Namespace Native -Name CredMan -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
public static extern bool CredDeleteW(string target, uint type, uint flags);
'@ -ErrorAction SilentlyContinue

function Remove-CredManTarget($Target) {
  try {
    if ([Native.CredMan]::CredDeleteW($Target, 1, 0)) { return $true }
    # 1168 = ERROR_NOT_FOUND: the entry is already gone, so treat it as success.
    return ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168)
  } catch { return $false }
}

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat-client uninstaller"

  $IdxLocate = Ui-ActionAdd "Locating tomat in Windows uninstall registry"
  $IdxRemove = Ui-ActionAdd "Uninstalling tomat (silent)"
  # Paired-core tokens live in Windows Credential Manager on stable/latest; dev
  # keeps them in keychain.json (removed with the data), so only add the step then.
  if ($Channel -ne "dev") {
    $IdxKeychain = Ui-ActionAdd "Clearing paired-core tokens"
  } else {
    $IdxKeychain = -1
  }
  $KeychainResidue = $false
  # Paired cores are always removed; settings only when not kept.
  if ($KeepData) {
    $IdxCores = Ui-ActionAdd "Removing paired-core list (keeping settings)"
    $IdxData = -1
  } else {
    $IdxCores = -1
    $IdxData = Ui-ActionAdd "Removing $ClientDir"
  }

  # --- action 1: locate product in uninstall registry --------------------

  Ui-ActionStart $IdxLocate "Locating tomat in Windows uninstall registry"

  # Case-insensitive match on DisplayName, scoped to this channel's product
  # (stable "tomat", latest "tomat (latest)"). $ProductPattern excludes other
  # channels so uninstalling stable never removes the latest app and vice versa.
  $product = $null
  foreach ($key in $UninstallKeys) {
    $product = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -and $_.DisplayName -match $ProductPattern } |
      Select-Object -First 1
    if ($product) { break }
  }

  if (-not $product) {
    Ui-ActionSkip $IdxLocate "(not installed)"
  } else {
    Ui-ActionDone $IdxLocate "(found: $($product.DisplayName))"
  }

  # --- action 2: run the uninstaller -------------------------------------

  if (-not $product) {
    Ui-ActionSkip $IdxRemove "(skipped -- nothing installed)"
  } else {
    Ui-ActionStart $IdxRemove "Uninstalling $($product.DisplayName) (silent)"

    # NSIS records QuietUninstallString ("<INSTDIR>\uninstall.exe" /S); a legacy
    # MSI records an msiexec command. Prefer the quiet form, fall back to the
    # plain UninstallString.
    $uninstall = $product.QuietUninstallString
    if (-not $uninstall) { $uninstall = $product.UninstallString }
    $installLoc = $product.InstallLocation

    if ($uninstall -match 'msiexec') {
      # Legacy per-machine MSI: hand off to msiexec /x.
      $proc = $null
      try {
        $proc = Start-Process -FilePath "msiexec.exe" `
          -ArgumentList "/x", $product.PSChildName, "/qb", "/norestart" `
          -Wait -PassThru
      } catch {
        Ui-Die "Could not launch msiexec" `
          $_.Exception.Message `
          "check that msiexec.exe is on PATH"
      }
      switch ($proc.ExitCode) {
        0     { Ui-ActionDone $IdxRemove "(uninstalled)" }
        1605  { Ui-ActionSkip $IdxRemove "(not installed)" }
        1602  { Ui-Die "Uninstall cancelled by user" "exit 1602" "re-run when ready" }
        1603  { Ui-Die "msiexec reported a fatal error" "exit 1603" "a file may be locked; quit any tomat process and re-run" }
        1618  { Ui-Die "Another MSI op running" "exit 1618" "wait and re-run" }
        default { Ui-Die "msiexec exit $($proc.ExitCode)" "" "look up code at learn.microsoft.com/windows/win32/msi/error-codes" }
      }
    } elseif ($uninstall) {
      # NSIS uninstaller. Split the "<path>" [args] command and force silent.
      if ($uninstall -match '^\s*"([^"]+)"\s*(.*)$') {
        $exe = $matches[1]; $argStr = $matches[2].Trim()
      } elseif ($uninstall -match '^\s*(\S+)\s*(.*)$') {
        $exe = $matches[1]; $argStr = $matches[2].Trim()
      } else {
        $exe = $uninstall; $argStr = ""
      }
      $argList = @()
      if ($argStr) { $argList = @($argStr -split '\s+') }
      if ($argList -notcontains "/S") { $argList += "/S" }

      if (-not (Test-Path $exe)) {
        Ui-ActionSkip $IdxRemove "(uninstaller missing; registry stale)"
      } else {
        try {
          Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru | Out-Null
        } catch {
          Ui-Die "Could not launch the uninstaller" `
            $_.Exception.Message `
            "quit any running tomat and re-run"
        }
        # A silent NSIS uninstall copies itself to %TEMP% and relaunches, so
        # -Wait can return before the install dir is gone. Poll it (up to ~30s)
        # to report completion accurately.
        if ($installLoc -and (Test-Path $installLoc)) {
          $deadline = (Get-Date).AddSeconds(30)
          while ((Test-Path $installLoc) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
          }
        }
        if ($installLoc -and (Test-Path $installLoc)) {
          Ui-ActionDone $IdxRemove "(uninstaller ran; some files may remain)"
        } else {
          Ui-ActionDone $IdxRemove "(uninstalled)"
        }
      }
    } else {
      Ui-ActionSkip $IdxRemove "(no uninstall command in registry)"
    }
  }

  # --- action 2b: clear paired-core tokens -------------------------------
  # Drop EVERY core:<id>.tomat-client<suffix> credential for this channel from
  # Windows Credential Manager, not only the ids still in cores.json: an abnormal
  # unpair can orphan a token, and client-uninstall.sh clears them all in one
  # `secret-tool clear service` too. Enumerate by matching the credential's
  # TARGET value in `cmdkey /list` (robust to a localized "Target:" label), then
  # CredDeleteW each (deleting an already-gone target is a no-op). The trailing
  # lookahead keeps a stable-channel run ("tomat-client") from also matching a
  # latest token ("tomat-client-latest").

  if ($IdxKeychain -ne -1) {
    Ui-ActionStart $IdxKeychain "Clearing paired-core tokens"
    $targets = @()
    try {
      $pattern = "core:[0-9A-Za-z]+\.$([regex]::Escape($KeychainService))(?=\s|`$)"
      $targets = @((cmdkey /list 2>$null) |
          Select-String -Pattern $pattern -AllMatches |
          ForEach-Object { $_.Matches.Value } | Select-Object -Unique)
    } catch { $targets = @() }
    if ($targets.Count -eq 0) {
      Ui-ActionSkip $IdxKeychain "(no tokens)"
    } else {
      $cleared = 0
      foreach ($t in $targets) {
        if (Remove-CredManTarget $t) { $cleared++ }
        else { $KeychainResidue = $true }
      }
      if ($KeychainResidue) {
        Ui-ActionSkip $IdxKeychain "(some tokens may remain)"
      } else {
        Ui-ActionDone $IdxKeychain "(cleared $cleared)"
      }
    }
  }

  # --- action 3: remove client data --------------------------------------
  # -KeepData drops only the paired-core files (cores.json + the dev-channel
  # keychain.json), leaving settings; otherwise the whole dir goes.

  if ($KeepData) {
    if (-not ((Test-Path $CoresJson) -or (Test-Path $KeychainJson))) {
      Ui-ActionSkip $IdxCores "(no paired cores)"
    } else {
      Ui-ActionStart $IdxCores "Removing paired-core list (keeping settings)"
      # Remove each existing file with a terminating error so a real failure (a
      # locked cores.json while the Client is still running) surfaces instead of
      # being swallowed and mis-reported as removed. Missing files are skipped by
      # the Test-Path guard rather than by suppressing errors.
      foreach ($f in @($CoresJson, $KeychainJson)) {
        if (Test-Path $f) {
          try {
            Remove-Item -Force $f -ErrorAction Stop
          } catch {
            Ui-Die "Could not remove paired-core file $f" `
              $_.Exception.Message `
              "quit tomat and re-run"
          }
        }
      }
      Ui-ActionDone $IdxCores "(removed)"
    }
  }

  if (-not $KeepData) {
    if (-not (Test-Path $ClientDir)) {
      Ui-ActionSkip $IdxData "(no data found)"
    } else {
      Ui-ActionStart $IdxData "Removing $ClientDir"
      try {
        Remove-Item -Recurse -Force $ClientDir
      } catch {
        Ui-Die "Permission denied removing $ClientDir" `
          $_.Exception.Message `
          "quit tomat and re-run"
      }
      # Best-effort: drop the now-empty channel dir (~/.tomat/<channel>) left
      # behind once both client and core data are gone. Only when empty, so a
      # core still installed on this channel keeps it; the shared models dir
      # under ~/.tomat is never affected. Mirrors client-uninstall.sh's
      # `rmdir "$HOME/.tomat/$TOMAT_CHANNEL"`.
      $channelDir = Split-Path -Parent $ClientDir
      try {
        if ((Test-Path $channelDir) -and -not (Get-ChildItem -Force $channelDir)) {
          Remove-Item -Force $channelDir
        }
      } catch { }
      Ui-ActionDone $IdxData "(removed)"
    }
  }

  # --- footer ------------------------------------------------------------

  if (-not $product) {
    $headline = "tomat-client uninstaller finished."
  } else {
    $headline = "tomat-client uninstalled."
  }

  # Build the finish notes. The paired-core list is always removed; on stable/latest
  # its tokens are cleared from Windows Credential Manager in action 2b. A residue
  # note is surfaced only when a delete actually failed, not by default.
  $notes = @()
  if ($KeepData) {
    $notes += "Settings in $ClientDir were kept (per -KeepData); the paired-core list was removed."
  }
  if ($KeychainResidue) {
    $notes += "Some paired-core tokens could not be removed from Windows Credential Manager; remove them manually if desired."
  }
  if ($notes.Count -gt 0) {
    Ui-Finish (@($headline, "") + $notes)
  } else {
    Ui-Finish @($headline)
  }

  exit 0
}
finally {
  _Ui-Cleanup
}
