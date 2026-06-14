# tomat-core uninstaller for Windows.
#
# Stops and unregisters the Scheduled Task, kills any straggler tomat-core
# process, then deletes %USERPROFILE%\.tomat\<channel>\core\. Models in
# %USERPROFILE%\.tomat\models\ are LEFT IN PLACE (shared across channels).
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/core-uninstall.ps1 | iex"
#
# Flags:
#   -KeepData  do not remove the core directory (only stop / unregister services).
#
# Env overrides:
#   $env:TOMAT_CHANNEL  channel to uninstall: stable (default) | dev | latest.
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*], and rows settle into [x] (done), [~] (no-op skip), or [!]
#   (error). Glyphs upgrade to checkmark/cross on Windows 10 1809+ and
#   Windows 11 (UTF-8 capable conhost / Terminal). Most failures are
#   non-fatal: the row settles [!] but the script keeps going through the
#   remaining actions.

param(
  [switch]$KeepData
)

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

# --- configuration --------------------------------------------------------

$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
$HomeDir = if ($env:TOMAT_CORE_HOME) { $env:TOMAT_CORE_HOME } else { Join-Path $HOME ".tomat\$Channel\core" }
# Channel-suffixed task + process names (stable stays bare).
$ChannelSuffix = if ($Channel -eq "stable") { "" } else { "-$Channel" }
$TaskName = "tomat-core$ChannelSuffix"
$ProcName = "tomat-core$ChannelSuffix"

# --- pick the data-removal label up front --------------------------------

if ($KeepData) {
  $DataLabel = "Removing $HomeDir (skipped per -KeepData)"
} else {
  $DataLabel = "Removing $HomeDir"
}

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat-core uninstaller"

  $IdxTask = Ui-ActionAdd "Unregistering Windows scheduled task '$TaskName'"
  $IdxKill = Ui-ActionAdd "Killing straggler tomat-core processes"
  $IdxData = Ui-ActionAdd $DataLabel

  # --- action 1: unregister scheduled task -------------------------------

  $existingTask = $null
  try {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  } catch { }

  if (-not $existingTask) {
    Ui-ActionSkip $IdxTask "(task not found)"
  } else {
    Ui-ActionStart $IdxTask "Unregistering Windows scheduled task '$TaskName'"
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    } catch { }

    $stillThere = $null
    try {
      $stillThere = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } catch { }

    if ($stillThere) {
      Ui-ActionError $IdxTask "(could not unregister)"
    } else {
      Ui-ActionDone $IdxTask "(unregistered)"
    }
  }

  # --- action 2: kill straggler processes --------------------------------

  $stragglers = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)

  if ($stragglers.Count -eq 0) {
    Ui-ActionSkip $IdxKill "(none found)"
  } else {
    Ui-ActionStart $IdxKill "Killing straggler tomat-core processes" "($($stragglers.Count) found)"
    $killed = 0
    foreach ($p in $stragglers) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        # Verify it actually died.
        Start-Sleep -Milliseconds 100
        $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if (-not $alive) {
          $killed = $killed + 1
        }
      } catch { }
    }
    Ui-ActionDone $IdxKill "(killed $killed)"
  }

  # --- action 3: remove home dir -----------------------------------------

  if ($KeepData) {
    Ui-ActionSkip $IdxData "(kept per -KeepData)"
  } elseif (-not (Test-Path $HomeDir)) {
    Ui-ActionSkip $IdxData "(directory not found)"
  } else {
    Ui-ActionStart $IdxData "Removing $HomeDir"
    try {
      Remove-Item -Recurse -Force $HomeDir
    } catch {
      Ui-Die "Failed to remove $HomeDir" `
        $_.Exception.Message `
        "a process may still be holding the directory open; re-run after closing tomat"
    }
    Ui-ActionDone $IdxData "(removed)"
  }

  # --- footer ------------------------------------------------------------

  if ($KeepData) {
    Ui-Finish @(
      "tomat-core uninstalled.",
      "",
      "$HomeDir kept per -KeepData.",
      "",
      "Models in ~\.tomat\models\ were left in place; remove manually if desired."
    )
  } else {
    Ui-Finish @(
      "tomat-core uninstalled.",
      "",
      "Models in ~\.tomat\models\ were left in place; remove manually if desired."
    )
  }

  exit 0
}
finally {
  _Ui-Cleanup
}
