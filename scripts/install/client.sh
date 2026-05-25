#!/usr/bin/env bash
# tomat-client installer for macOS / Linux.
#
# Fetches client.json from the CDN, picks the matching artifact for this host
# triple, downloads it, and installs:
#   - macOS: mounts the .dmg, copies Tomat.app to /Applications, removes the
#            com.apple.quarantine xattr so Gatekeeper doesn't show the
#            "developer cannot be verified" sheet on first launch (curl
#            downloads don't set the xattr in the first place — this is a
#            belt-and-braces step).
#   - Linux: drops the AppImage into ~/.local/bin, chmod +x it, registers a
#            .desktop entry so it shows up in launchers.
#
# Usage:
#   curl -fsSL https://au.tomat.ing/install/client.sh | bash
#
# Env overrides:
#   TOMAT_CDN     override CDN base URL (default: https://au.tomat.ing)

set -euo pipefail

CDN="${TOMAT_CDN:-https://au.tomat.ing}"
MANIFEST_URL="$CDN/manifests/client.json"

err() { echo "error: $*" >&2; exit 1; }
info() { echo ">>> $*"; }

# --- detect triple --------------------------------------------------------

detect_triple() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="apple-darwin" ;;
    Linux)  os="unknown-linux-gnu" ;;
    *)      err "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) err "unsupported arch: $(uname -m)" ;;
  esac
  echo "${arch}-${os}"
}

TRIPLE="$(detect_triple)"
info "host triple: $TRIPLE"

# --- prerequisites --------------------------------------------------------

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || err "missing required command: $cmd"
done

# --- fetch + parse manifest -----------------------------------------------

info "fetching $MANIFEST_URL"
MANIFEST_JSON="$(curl -fsSL "$MANIFEST_URL")"
[ -n "$MANIFEST_JSON" ] || err "empty manifest"

VERSION="$(echo "$MANIFEST_JSON" | jq -r '.version // empty')"
[ -n "$VERSION" ] || err "manifest missing version"
URL="$(echo "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.platforms[$t].url // empty')"
[ -n "$URL" ] || err "no client artifact for triple $TRIPLE in manifest"

info "version $VERSION → $URL"

# --- platform install ----------------------------------------------------

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

case "$(uname -s)" in
  Darwin)
    # We ship the .app as a gzipped tarball (the same artifact
    # tauri-plugin-updater consumes for in-app updates) rather than a DMG
    # — DMG bundling on macOS triggers a Finder window via AppleScript on
    # every build, which is jarring. Extract it straight into /Applications.
    TARBALL="$TMP_DIR/tomat-client.app.tar.gz"
    info "downloading .app.tar.gz"
    # curl-fetched files do NOT inherit the quarantine xattr the way browser
    # downloads do, so Gatekeeper won't show the "developer cannot be
    # verified" sheet for the ad-hoc-signed bundle inside.
    curl -fsSL -o "$TARBALL" "$URL"

    info "extracting"
    EXTRACT_DIR="$TMP_DIR/extracted"
    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$TARBALL" -C "$EXTRACT_DIR"

    APP_SRC="$(find "$EXTRACT_DIR" -maxdepth 2 -name "*.app" -type d | head -n1)"
    [ -n "$APP_SRC" ] || err "no .app inside tarball"

    APP_NAME="$(basename "$APP_SRC")"
    DEST="/Applications/$APP_NAME"
    if [ -d "$DEST" ]; then
      info "removing existing $DEST"
      rm -rf "$DEST"
    fi
    info "copying to $DEST"
    cp -R "$APP_SRC" "/Applications/"

    info "clearing quarantine xattr"
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

    echo ""
    echo "  Tomat installed → $DEST"
    echo "  Launch from /Applications or via Spotlight."
    echo ""
    ;;
  Linux)
    BIN_DIR="$HOME/.local/bin"
    APPS_DIR="$HOME/.local/share/applications"
    ICONS_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
    mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR"

    APPIMAGE="$BIN_DIR/tomat-client.AppImage"
    info "downloading AppImage → $APPIMAGE"
    curl -fsSL -o "$APPIMAGE" "$URL"
    chmod +x "$APPIMAGE"

    DESKTOP="$APPS_DIR/tomat-client.desktop"
    cat >"$DESKTOP" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Tomat
Comment=Local-first modular AI client
Exec=$APPIMAGE
Icon=tomat-client
Terminal=false
Categories=Utility;
DESKTOP
    info "wrote $DESKTOP"

    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$APPS_DIR" 2>/dev/null || true
    fi

    echo ""
    echo "  Tomat installed → $APPIMAGE"
    echo "  Launch via your application menu or run $APPIMAGE directly."
    echo ""
    ;;
esac
