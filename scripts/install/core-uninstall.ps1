# tomat-core uninstaller for Windows.
#
# Stops and unregisters the Scheduled Task, kills any straggler tomat-core
# process, then deletes %USERPROFILE%\.tomat\core\. Models in
# %USERPROFILE%\.tomat\models\ are LEFT IN PLACE.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://au.tomat.ing/install/core-uninstall.ps1 | iex"
#
# Flags:
#   -KeepData  do not remove the core directory (only stop / unregister services).

param(
  [switch]$KeepData
)

$ErrorActionPreference = "Stop"

$HomeDir = if ($env:TOMAT_CORE_HOME) { $env:TOMAT_CORE_HOME } else { Join-Path $HOME ".tomat\core" }
$TaskName = "tomat-core"

function Info($msg) { Write-Host ">>> $msg" -ForegroundColor Cyan }

# --- stop scheduled task --------------------------------------------------

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Info "stopping scheduled task"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "warn: could not stop / remove scheduled task: $_" -ForegroundColor Yellow
}

# --- kill any straggler process ------------------------------------------

try {
  Get-Process -Name "tomat-core" -ErrorAction SilentlyContinue | ForEach-Object {
    Info "killing pid $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "warn: could not kill core process: $_" -ForegroundColor Yellow
}

# --- remove home dir ------------------------------------------------------

if ($KeepData) {
  Info "keeping $HomeDir (per -KeepData)"
} else {
  if (Test-Path $HomeDir) {
    Info "removing $HomeDir"
    Remove-Item -Recurse -Force $HomeDir
  }
}

Info "tomat-core uninstalled."
Write-Host "  Models in ~\.tomat\models\ were left in place; remove manually if desired."
