#!/usr/bin/env bash
# tomat-core uninstaller for macOS / Linux.
#
# Stops and unregisters the launchd / systemd-user service, then deletes
# ~/.tomat/core/. Models in ~/.tomat/models/ are LEFT IN PLACE because they
# can be huge and the user may want to keep them — re-running the installer
# will pick them back up.
#
# Usage:
#   curl -fsSL https://au.tomat.ing/install/core-uninstall.sh | bash
#   curl -fsSL https://au.tomat.ing/install/core-uninstall.sh | bash -s -- --keep-data
#
# Flags:
#   --keep-data  do not remove ~/.tomat/core/ (only stop / unregister services).
#
# Env overrides:
#   TOMAT_CORE_HOME    override install root (default: ~/.tomat/core)

set -euo pipefail

HOME_DIR="${TOMAT_CORE_HOME:-$HOME/.tomat/core}"
KEEP_DATA=0

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=1 ;;
    *) echo "warn: unknown arg: $arg" >&2 ;;
  esac
done

err() { echo "error: $*" >&2; exit 1; }
info() { echo ">>> $*"; }

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/au.tomat.core.plist"
    if [ -f "$PLIST" ]; then
      info "unloading launchd agent"
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
    fi
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/tomat-core.service"
    if [ -f "$UNIT" ]; then
      info "stopping systemd-user unit"
      systemctl --user disable --now tomat-core.service 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload 2>/dev/null || true
    fi
    ;;
  *)
    err "unsupported OS: $(uname -s)"
    ;;
esac

# Best-effort kill of any stragglers (on-demand-mode installs leave no service,
# so the only way to stop is by PID; pgrep is widely available enough).
if command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "$HOME_DIR/bin/tomat-core" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    info "killing running core process(es): $pids"
    # Try SIGTERM first; SIGKILL after a short grace.
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
fi

if [ "$KEEP_DATA" -eq 1 ]; then
  info "keeping $HOME_DIR (per --keep-data)"
else
  if [ -d "$HOME_DIR" ]; then
    info "removing $HOME_DIR"
    rm -rf "$HOME_DIR"
  fi
fi

info "tomat-core uninstalled."
echo "  Models in ~/.tomat/models/ were left in place; remove manually if desired."
