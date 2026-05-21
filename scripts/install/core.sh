#!/usr/bin/env bash
# tomat-core installer for macOS / Linux.
#
# Detects the host triple, downloads the signed core manifest from the CDN
# (au.tomat.ing), picks the matching binary, verifies its SHA-256, installs
# it to ~/.tomat/core/bin/tomat-core, creates the admin token + a launchd
# (macOS) / systemd-user (Linux) service for auto-start, starts the daemon,
# and prints the initial pairing code.
#
# Usage:
#   curl -fsSL https://au.tomat.ing/install/core.sh | bash
#
# Env overrides:
#   TOMAT_CDN          override CDN base URL (default: https://au.tomat.ing)
#   TOMAT_CORE_HOME    override install root (default: ~/.tomat/core)

set -euo pipefail

CDN="${TOMAT_CDN:-https://au.tomat.ing}"
HOME_DIR="${TOMAT_CORE_HOME:-$HOME/.tomat/core}"
BIN_DIR="$HOME_DIR/bin"
WORKERS_DIR="$HOME_DIR/workers"
MANIFEST_URL="$CDN/manifests/core.json"

err() { echo "error: $*" >&2; exit 1; }
info() { echo ">>> $*"; }

# --- detect triple ---------------------------------------------------------

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

# --- prerequisites ---------------------------------------------------------

for cmd in curl jq sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || {
    # macOS doesn't ship sha256sum; fall back to `shasum -a 256`
    if [ "$cmd" = "sha256sum" ] && command -v shasum >/dev/null 2>&1; then
      continue
    fi
    err "missing required command: $cmd"
  }
done
SHA_CMD="sha256sum"
command -v sha256sum >/dev/null 2>&1 || SHA_CMD="shasum -a 256"

# --- fetch + parse manifest -----------------------------------------------

info "fetching $MANIFEST_URL"
MANIFEST_JSON="$(curl -fsSL "$MANIFEST_URL")"
[ -n "$MANIFEST_JSON" ] || err "empty manifest"

VERSION="$(echo "$MANIFEST_JSON" | jq -r '.version // empty')"
[ -n "$VERSION" ] || err "manifest missing version"
URL="$(echo "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.binaries[] | select(.triple==$t) | .url')"
SHA256="$(echo "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.binaries[] | select(.triple==$t) | .sha256')"
[ -n "$URL" ] && [ -n "$SHA256" ] || err "no binary for triple $TRIPLE in manifest"

info "version $VERSION"

# NOTE: signature verification is currently performed by the core binary
# itself on update (via the baked-in Ed25519 public key). For the very
# first install we trust the TLS connection to au.tomat.ing + the SHA-256
# in the manifest. If you need stricter posture, verify the manifest
# signature here with `openssl pkeyutl` or similar before downloading.

# --- download + verify ----------------------------------------------------

mkdir -p "$BIN_DIR" "$WORKERS_DIR" "$HOME_DIR/staging" "$HOME_DIR/logs"
TMP="$HOME_DIR/staging/tomat-core-$VERSION-$$"
info "downloading $URL"
curl -fsSL -o "$TMP" "$URL"

GOT="$($SHA_CMD "$TMP" | awk '{print $1}')"
if [ "$GOT" != "$SHA256" ]; then
  rm -f "$TMP"
  err "sha256 mismatch: want $SHA256, got $GOT"
fi
info "sha256 ok"

INSTALLED="$BIN_DIR/tomat-core"
mv -f "$TMP" "$INSTALLED"
chmod 0755 "$INSTALLED"
info "installed to $INSTALLED"

# --- download workers -----------------------------------------------------
# Worker .ts files are platform-independent and run as Deno subprocesses
# spawned by the core. Their npm deps (transformers / kokoro / onnxruntime,
# ~1.5 GB) download lazily into ~/.tomat/core/deno-cache on first use.

WORKERS_COUNT="$(echo "$MANIFEST_JSON" | jq -r '.workers // [] | length')"
if [ "$WORKERS_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((WORKERS_COUNT - 1))); do
    W_NAME="$(echo "$MANIFEST_JSON" | jq -r ".workers[$i].name")"
    W_URL="$(echo "$MANIFEST_JSON" | jq -r ".workers[$i].url")"
    W_SHA="$(echo "$MANIFEST_JSON" | jq -r ".workers[$i].sha256")"
    W_TMP="$HOME_DIR/staging/$W_NAME-$VERSION-$$"
    info "downloading worker $W_NAME"
    curl -fsSL -o "$W_TMP" "$W_URL"
    W_GOT="$($SHA_CMD "$W_TMP" | awk '{print $1}')"
    if [ "$W_GOT" != "$W_SHA" ]; then
      rm -f "$W_TMP"
      err "worker $W_NAME sha256 mismatch: want $W_SHA, got $W_GOT"
    fi
    mv -f "$W_TMP" "$WORKERS_DIR/$W_NAME"
    info "installed worker → $WORKERS_DIR/$W_NAME"
  done
fi

# --- download helpers -----------------------------------------------------
# Native helper binary (tomat-core-keychain wraps the OS keychain).
# Each helper is per-triple — install only the ones matching our host.

HELPERS_COUNT="$(echo "$MANIFEST_JSON" | jq -r '.helpers // [] | length')"
if [ "$HELPERS_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((HELPERS_COUNT - 1))); do
    H_TRIPLE="$(echo "$MANIFEST_JSON" | jq -r ".helpers[$i].triple")"
    [ "$H_TRIPLE" = "$TRIPLE" ] || continue
    H_NAME="$(echo "$MANIFEST_JSON" | jq -r ".helpers[$i].name")"
    H_URL="$(echo "$MANIFEST_JSON" | jq -r ".helpers[$i].url")"
    H_SHA="$(echo "$MANIFEST_JSON" | jq -r ".helpers[$i].sha256")"
    H_TMP="$HOME_DIR/staging/$H_NAME-$VERSION-$$"
    info "downloading helper $H_NAME"
    curl -fsSL -o "$H_TMP" "$H_URL"
    H_GOT="$($SHA_CMD "$H_TMP" | awk '{print $1}')"
    if [ "$H_GOT" != "$H_SHA" ]; then
      rm -f "$H_TMP"
      err "helper $H_NAME sha256 mismatch: want $H_SHA, got $H_GOT"
    fi
    mv -f "$H_TMP" "$BIN_DIR/$H_NAME"
    chmod 0755 "$BIN_DIR/$H_NAME"
    info "installed helper → $BIN_DIR/$H_NAME"
  done
fi

# --- admin token ----------------------------------------------------------

ADMIN_TOKEN_FILE="$HOME_DIR/.admin-token"
if [ ! -s "$ADMIN_TOKEN_FILE" ]; then
  head -c 16 /dev/urandom | xxd -p -c 256 > "$ADMIN_TOKEN_FILE"
  chmod 0600 "$ADMIN_TOKEN_FILE"
  info "admin token written to $ADMIN_TOKEN_FILE"
fi

# --- service (launchd / systemd-user) -------------------------------------

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/au.tomat.core.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>au.tomat.core</string>
  <key>ProgramArguments</key><array><string>$INSTALLED</string></array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>$HOME_DIR/logs/core.stdout.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/core.stderr.log</string>
</dict>
</plist>
PLIST
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    info "launchd agent installed: $PLIST"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT="$UNIT_DIR/tomat-core.service"
    cat >"$UNIT" <<UNIT
[Unit]
Description=tomat-core
After=network-online.target

[Service]
ExecStart=$INSTALLED
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME_DIR/logs/core.stdout.log
StandardError=append:$HOME_DIR/logs/core.stderr.log

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload || true
    systemctl --user enable --now tomat-core.service || true
    info "systemd-user unit installed: $UNIT"
    ;;
esac

# --- print pairing code ----------------------------------------------------

info "waiting 2s for core to bind…"
sleep 2

if command -v curl >/dev/null 2>&1; then
  ADMIN="$(cat "$ADMIN_TOKEN_FILE")"
  CODE_JSON="$(curl -fsS -X POST -H "X-Admin-Token: $ADMIN" \
    "http://127.0.0.1:7800/api/v1/pairing/codes" -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null || true)"
  CODE="$(echo "$CODE_JSON" | jq -r '.code // empty' 2>/dev/null || true)"
  if [ -n "$CODE" ]; then
    echo ""
    echo "  Pairing code: $CODE"
    echo ""
    echo "  Open tomat-client → Pair → enter:"
    echo "    URL : http://127.0.0.1:7800   (or this host's LAN IP)"
    echo "    Code: $CODE"
    echo ""
    exit 0
  fi
fi

echo ""
echo "tomat-core installed. Mint a pairing code with:"
echo "  curl -X POST -H \"X-Admin-Token: \$(cat $ADMIN_TOKEN_FILE)\" \\"
echo "       -H 'Content-Type: application/json' -d '{}' \\"
echo "       http://127.0.0.1:7800/api/v1/pairing/codes"
echo ""
