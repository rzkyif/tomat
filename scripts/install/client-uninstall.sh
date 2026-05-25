#!/usr/bin/env bash
# tomat-client uninstaller for macOS / Linux.
#
# Removes the platform-native install:
#   - macOS: deletes /Applications/Tomat.app.
#   - Linux: deletes ~/.local/bin/tomat-client.AppImage and its .desktop entry.
#
# Client-side data (~/.tomat/client/) is LEFT IN PLACE so a future re-install
# picks up the user's paired-core list and UI prefs. Use --purge to wipe.
#
# Usage:
#   curl -fsSL https://au.tomat.ing/install/client-uninstall.sh | bash
#   curl -fsSL https://au.tomat.ing/install/client-uninstall.sh | bash -s -- --purge

set -euo pipefail

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) echo "warn: unknown arg: $arg" >&2 ;;
  esac
done

err() { echo "error: $*" >&2; exit 1; }
info() { echo ">>> $*"; }

case "$(uname -s)" in
  Darwin)
    APP="/Applications/Tomat.app"
    if [ -d "$APP" ]; then
      info "removing $APP"
      rm -rf "$APP"
    else
      info "no $APP found"
    fi
    ;;
  Linux)
    APPIMAGE="$HOME/.local/bin/tomat-client.AppImage"
    DESKTOP="$HOME/.local/share/applications/tomat-client.desktop"
    ICON="$HOME/.local/share/icons/hicolor/512x512/apps/tomat-client.png"
    for f in "$APPIMAGE" "$DESKTOP" "$ICON"; do
      if [ -f "$f" ]; then
        info "removing $f"
        rm -f "$f"
      fi
    done
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    ;;
  *)
    err "unsupported OS: $(uname -s)"
    ;;
esac

if [ "$PURGE" -eq 1 ]; then
  if [ -d "$HOME/.tomat/client" ]; then
    info "removing $HOME/.tomat/client (per --purge)"
    rm -rf "$HOME/.tomat/client"
  fi
fi

info "tomat-client uninstalled."
if [ "$PURGE" -eq 0 ]; then
  echo "  Settings in ~/.tomat/client/ were left in place. Re-run with --purge to remove."
fi
