#!/usr/bin/env bash
# tomat-core installer for macOS / Linux.
#
# Detects the host triple, downloads the signed core manifest from the
# storage origin (get.au.tomat.ing), picks the matching binary, verifies its
# SHA-256, installs it to ~/.tomat/<channel>/core/bin/tomat-core, creates the
# admin token + a launchd (macOS) / systemd-user (Linux) service for
# auto-start, starts the daemon, and prints the initial pairing code.
#
# Usage:
#   curl -fsSL https://get.au.tomat.ing/install/core.sh | bash
#
# Env overrides:
#   TOMAT_STORAGE          override storage base URL (default: https://get.au.tomat.ing)
#   TOMAT_CHANNEL          install channel: stable (default) | dev | latest. Selects
#                          the ~/.tomat/<channel>/core subtree and is baked into the
#                          service environment so the daemon uses the same channel.
#   TOMAT_CORE_HOME        override install root (default: ~/.tomat/<channel>/core)
#   TOMAT_INSTALL_SERVICE  "1" (default) installs the launchd / systemd unit
#                          so the core boots on login. "0" skips it; the
#                          client launches the core on demand via the
#                          `start_local_core` Tauri command.
#   TOMAT_INSTALL_BIND_ALL "1" seeds settings.json with
#                          server.bindHost=0.0.0.0 so the freshly-installed
#                          core listens on all interfaces and other LAN devices
#                          can pair. "0" (default) keeps the loopback bind.
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   animates as [*] (spinner in TTY mode), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   UTF-8 locales; colors render only on a TTY. Pipe through `cat`/`tee` to
#   get a flat transcript with no escape codes.

set -euo pipefail

# ===== UI helpers begin =====
# Self-contained UI helper block. Keep this region intact so future install
# scripts can copy it verbatim. No external state, no shared library --
# everything below operates on module-level variables only.

# --- UI state -------------------------------------------------------------

UI_TTY=0
[ -t 1 ] && UI_TTY=1

UI_UTF8=0
case "${LANG:-}${LC_ALL:-}${LC_CTYPE:-}" in
  *UTF-8*|*utf8*|*UTF8*) UI_UTF8=1 ;;
esac

UI_CURRENT_IDX=-1     # row currently in [*] doing state, -1 if none
UI_SPIN_PID=0         # background spinner pid, 0 if no spinner running
UI_CURRENT_LABEL=""   # label of the row currently doing (for spinner repaints)
UI_CURRENT_SUFFIX=""  # mutable suffix like "(2/3)" / "(downloading)"

# Row count and per-row labels need to survive command substitution because
# `IDX=$(ui_action_add ...)` runs the helper in a subshell -- variable
# assignments there are lost in the parent. We back them with a tiny
# per-process state dir created in ui_init.
UI_STATE_DIR=""        # populated by ui_init

# Track every staging path we create so the EXIT/INT traps can clean them up
# whether the script succeeded or aborted partway.
UI_STAGING_PATHS=""

# Glyphs. ASCII baseline; upgrade to unicode if locale supports it.
UI_G_PEND=" "
UI_G_DOING="*"
UI_G_DONE="x"
UI_G_SKIP="~"
UI_G_ERR="!"
if [ "$UI_UTF8" = 1 ]; then
  UI_G_DONE="✓"
  UI_G_ERR="✗"
fi

# Colors -- only when we're on a TTY with a working tput. Without working
# cursor-up sequences we can't repaint rows in place, so degrade to non-TTY
# mode: that path emits one line per state transition instead, which is
# correct for dumb terminals (TERM=dumb, TERM unset, tput missing).
UI_C_GREEN=""
UI_C_RED=""
UI_C_DIM=""
UI_C_RESET=""
if [ "$UI_TTY" = 1 ]; then
  if ! command -v tput >/dev/null 2>&1 || [ -z "$(tput cuu 1 2>/dev/null)" ]; then
    UI_TTY=0
  else
    UI_C_GREEN="$(tput setaf 2 2>/dev/null || true)"
    UI_C_RED="$(tput setaf 1 2>/dev/null || true)"
    UI_C_DIM="$(tput dim 2>/dev/null || true)"
    UI_C_RESET="$(tput sgr0 2>/dev/null || true)"
  fi
fi

# --- low-level row rendering ----------------------------------------------
#
# Every UI write goes through fd 3 (set up in ui_init as a dup of the
# original stdout). This keeps `IDX=$(ui_action_add ...)` clean -- the row
# appears on the terminal, but only the numeric index reaches the command
# substitution on fd 1.

# Format a single row as a string and emit it to fd 3.
_ui_format_row() {
  # $1 glyph, $2 color, $3 label, $4 suffix (may be empty)
  local glyph="$1" color="$2" label="$3" suffix="$4"
  if [ -n "$suffix" ]; then
    printf '  [%s%s%s] %s %s%s%s' \
      "$color" "$glyph" "$UI_C_RESET" "$label" \
      "$UI_C_DIM" "$suffix" "$UI_C_RESET" >&3
  else
    printf '  [%s%s%s] %s' \
      "$color" "$glyph" "$UI_C_RESET" "$label" >&3
  fi
}

# Repaint row $1 in-place. TTY only -- caller checks UI_TTY before calling.
_ui_repaint_row() {
  # $1 idx, $2 glyph, $3 color, $4 label, $5 suffix
  local idx="$1" glyph="$2" color="$3" label="$4" suffix="$5"
  local total
  total="$(_ui_rows_total)"
  local offset=$((total - idx))
  printf '\r' >&3
  if [ "$offset" -gt 0 ]; then
    tput cuu "$offset" >&3 2>/dev/null || true
  fi
  tput el >&3 2>/dev/null || true
  _ui_format_row "$glyph" "$color" "$label" "$suffix"
  if [ "$offset" -gt 0 ]; then
    tput cud "$offset" >&3 2>/dev/null || true
  fi
  printf '\r' >&3
}

# State-dir backed helpers. Each of the row-total counter and the per-row
# labels lives in a tiny file; this is the only way to share state across
# the `$(...)` subshell that wraps every ui_action_add call.

_ui_rows_total() {
  if [ -n "$UI_STATE_DIR" ] && [ -f "$UI_STATE_DIR/rows_total" ]; then
    cat "$UI_STATE_DIR/rows_total"
  else
    printf '0'
  fi
}

_ui_set_rows_total() {
  printf '%s' "$1" > "$UI_STATE_DIR/rows_total"
}

_ui_set_label() {
  # $1 idx, $2 label
  printf '%s' "$2" > "$UI_STATE_DIR/label_$1"
}

_ui_get_label() {
  if [ -f "$UI_STATE_DIR/label_$1" ]; then
    cat "$UI_STATE_DIR/label_$1"
  else
    printf ''
  fi
}

# --- spinner --------------------------------------------------------------

_ui_spin() {
  local idx="$1"
  local frames='|/-\'
  local i=0
  local ch
  while :; do
    ch="$(printf '%s' "$frames" | cut -c $((i % 4 + 1)))"
    _ui_repaint_row "$idx" "$ch" "" "$UI_CURRENT_LABEL" "$UI_CURRENT_SUFFIX"
    sleep 0.12
    i=$((i + 1))
  done
}

_ui_stop_spinner() {
  if [ "$UI_SPIN_PID" != 0 ]; then
    kill "$UI_SPIN_PID" 2>/dev/null || true
    wait "$UI_SPIN_PID" 2>/dev/null || true
    UI_SPIN_PID=0
  fi
}

# --- staging cleanup ------------------------------------------------------

_ui_track_staging() {
  # Newline-separated so a path containing spaces survives cleanup's word split.
  UI_STAGING_PATHS="$UI_STAGING_PATHS
$1"
}

_ui_cleanup_staging() {
  local p
  local _old_ifs="$IFS"
  IFS='
'
  for p in $UI_STAGING_PATHS; do
    [ -n "$p" ] && [ -e "$p" ] && rm -f "$p" 2>/dev/null || true
  done
  IFS="$_old_ifs"
  UI_STAGING_PATHS=""
}

# --- traps ----------------------------------------------------------------

_ui_trap_err() {
  local rc=$?
  if [ "$UI_CURRENT_IDX" -ge 0 ]; then
    _ui_stop_spinner
    if [ "$UI_TTY" = 1 ]; then
      _ui_repaint_row "$UI_CURRENT_IDX" "$UI_G_ERR" "$UI_C_RED" \
        "$UI_CURRENT_LABEL" "(failed)"
    else
      printf '  [%s] %s (failed)\n' "$UI_G_ERR" "$UI_CURRENT_LABEL" >&3
    fi
    UI_CURRENT_IDX=-1
  fi
  tput cnorm >&3 2>/dev/null || true
  _ui_cleanup_staging
  exit "$rc"
}

_ui_trap_int() {
  _ui_stop_spinner
  tput cnorm >&3 2>/dev/null || true
  _ui_cleanup_staging
  exit 130
}

_ui_trap_exit() {
  _ui_stop_spinner
  tput cnorm >&3 2>/dev/null || true
  _ui_cleanup_staging
  if [ -n "$UI_STATE_DIR" ] && [ -d "$UI_STATE_DIR" ]; then
    rm -rf "$UI_STATE_DIR" 2>/dev/null || true
  fi
}

# --- public surface -------------------------------------------------------

# ui_init "TITLE" -- set up fd 3 (UI sink), emit the title block, install
# the EXIT/INT/ERR traps.
ui_init() {
  local title="$1"
  # Dup stdout onto fd 3 so the rest of the UI keeps writing to the
  # terminal even when callers wrap helpers in `$(...)`.
  exec 3>&1
  # State dir for the rows-total counter and per-row labels; both need to
  # survive `IDX=$(ui_action_add ...)`'s subshell. mktemp is POSIX-y but
  # macOS and GNU disagree on the template; the form below works on both.
  UI_STATE_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t tomat-ui)"
  printf '0' > "$UI_STATE_DIR/rows_total"
  printf '\n' >&3
  printf '  %s\n' "$title" >&3
  printf '\n' >&3
  if [ "$UI_TTY" = 1 ]; then
    tput civis >&3 2>/dev/null || true
  fi
  trap _ui_trap_err ERR
  trap _ui_trap_int INT
  trap _ui_trap_exit EXIT
}

# ui_action_add "LABEL" -- register a row and print its index to stdout so
# the caller can capture it via IDX=$(ui_action_add "...").
ui_action_add() {
  local label="$1"
  local idx
  idx="$(_ui_rows_total)"
  _ui_set_label "$idx" "$label"
  _ui_set_rows_total "$((idx + 1))"
  # Print the pending row to fd 3 (the terminal) so command-substitution
  # callers don't capture it.
  _ui_format_row "$UI_G_PEND" "" "$label" ""
  printf '\n' >&3
  # Only the numeric index goes to fd 1 for capture.
  printf '%s' "$idx"
}

# ui_action_start IDX "LABEL" ["SUFFIX"]
# Flip the row to [*] and start the spinner in TTY mode. In non-TTY mode,
# emit a fresh line so transcripts capture the state transition.
ui_action_start() {
  local idx="$1"
  local label="$2"
  local suffix="${3:-}"
  UI_CURRENT_IDX="$idx"
  UI_CURRENT_LABEL="$label"
  UI_CURRENT_SUFFIX="$suffix"
  if [ "$UI_TTY" = 1 ]; then
    _ui_repaint_row "$idx" "$UI_G_DOING" "" "$label" "$suffix"
    _ui_spin "$idx" &
    UI_SPIN_PID=$!
  else
    _ui_format_row "$UI_G_DOING" "" "$label" "$suffix"
    printf '\n' >&3
  fi
}

# ui_action_update IDX "SUFFIX" -- mutate the in-flight row's inline suffix.
ui_action_update() {
  local idx="$1"
  local suffix="$2"
  UI_CURRENT_SUFFIX="$suffix"
  if [ "$UI_TTY" = 1 ]; then
    # Spinner picks up the new suffix on its next tick -- no explicit repaint
    # is needed, and a manual one would race the spinner.
    :
  else
    _ui_format_row "$UI_G_DOING" "" "$UI_CURRENT_LABEL" "$suffix"
    printf '\n' >&3
  fi
}

# Shared exit-of-doing-state finisher.
_ui_action_finalize() {
  local idx="$1" glyph="$2" color="$3" detail="${4:-}"
  _ui_stop_spinner
  local label
  label="$(_ui_get_label "$idx")"
  if [ "$UI_TTY" = 1 ]; then
    _ui_repaint_row "$idx" "$glyph" "$color" "$label" "$detail"
  else
    _ui_format_row "$glyph" "$color" "$label" "$detail"
    printf '\n' >&3
  fi
  UI_CURRENT_IDX=-1
  UI_CURRENT_LABEL=""
  UI_CURRENT_SUFFIX=""
}

ui_action_done() {
  _ui_action_finalize "$1" "$UI_G_DONE" "$UI_C_GREEN" "${2:-}"
}

ui_action_skip() {
  _ui_action_finalize "$1" "$UI_G_SKIP" "$UI_C_GREEN" "${2:-}"
}

ui_action_error() {
  _ui_action_finalize "$1" "$UI_G_ERR" "$UI_C_RED" "${2:-}"
}

# ui_finish "FOOTER_LINE_1" "FOOTER_LINE_2" ... -- restore cursor, emit a
# blank line, the footer lines (indented 2 spaces), then a trailing blank.
ui_finish() {
  if [ "$UI_TTY" = 1 ]; then
    tput cnorm >&3 2>/dev/null || true
  fi
  printf '\n' >&3
  local line
  for line in "$@"; do
    if [ -z "$line" ]; then
      printf '\n' >&3
    else
      printf '  %s\n' "$line" >&3
    fi
  done
  printf '\n' >&3
}

# ui_die "REASON" ["DETAIL_LINE"] ["HINT"]
# Flip the current row to [✗] if there is one, restore the cursor, emit the
# structured error block to stderr, run cleanup, and exit 1.
ui_die() {
  local reason="$1"
  local detail="${2:-}"
  local hint="${3:-}"
  if [ "$UI_CURRENT_IDX" -ge 0 ]; then
    _ui_action_finalize "$UI_CURRENT_IDX" "$UI_G_ERR" "$UI_C_RED" "$reason"
  fi
  if [ "$UI_TTY" = 1 ]; then
    tput cnorm >&3 2>/dev/null || true
  fi
  printf '\n' >&2
  printf '%serror:%s %s\n' "$UI_C_RED" "$UI_C_RESET" "$reason" >&2
  if [ -n "$detail" ]; then
    printf '       %s\n' "$detail" >&2
  fi
  if [ -n "$hint" ]; then
    printf '%shint:%s  %s\n' "$UI_C_DIM" "$UI_C_RESET" "$hint" >&2
  fi
  printf '\n' >&2
  # Disable the ERR trap so cleanup doesn't recurse, then bail.
  trap - ERR
  _ui_cleanup_staging
  exit 1
}

# ===== UI helpers end =====

# --- configuration --------------------------------------------------------

STORAGE="${TOMAT_STORAGE:-https://get.au.tomat.ing}"
# Install channel. Every channel lives under ~/.tomat/<channel>/ so dev /
# latest installs never collide with stable. Selectable via the TOMAT_CHANNEL
# env var or a `--channel <c>` / `--latest` argument (the arg wins). Validate up
# front; an unknown value would mis-place state and confuse the client's
# channel resolver.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) TOMAT_CHANNEL="${2:-}"; shift 2 ;;
    --channel=*) TOMAT_CHANNEL="${1#*=}"; shift ;;
    --latest) TOMAT_CHANNEL="latest"; shift ;;
    --stable) TOMAT_CHANNEL="stable"; shift ;;
    *) shift ;;
  esac
done
TOMAT_CHANNEL="${TOMAT_CHANNEL:-stable}"
case "$TOMAT_CHANNEL" in
  stable | dev | latest) ;;
  *)
    printf 'error: invalid TOMAT_CHANNEL: %s (expected stable, dev, or latest)\n' \
      "$TOMAT_CHANNEL" >&2
    exit 1
    ;;
esac
# Per-channel naming + port. Stable stays bare (back-compat); dev/latest get a
# suffix on binary + service names, a /<channel> manifest path segment, and a
# port offset so both channels can run as services at once. Mirrors the
# runtime side (core paths.ts channelSuffix/corePort + config.ts manifestDir).
if [ "$TOMAT_CHANNEL" = "stable" ]; then
  CHANNEL_SUFFIX=""
  MANIFEST_DIR="manifests"
  PORT_OFFSET=0
else
  CHANNEL_SUFFIX="-$TOMAT_CHANNEL"
  MANIFEST_DIR="manifests/$TOMAT_CHANNEL"
  case "$TOMAT_CHANNEL" in
    latest) PORT_OFFSET=10 ;;
    dev) PORT_OFFSET=20 ;;
  esac
fi
CORE_PORT=$((7800 + PORT_OFFSET))
HOME_DIR="${TOMAT_CORE_HOME:-$HOME/.tomat/$TOMAT_CHANNEL/core}"
BIN_DIR="$HOME_DIR/bin"
WORKERS_DIR="$HOME_DIR/workers"
EXTENSIONS_DIR="$HOME_DIR/extensions"
STAGING_DIR="$HOME_DIR/staging"
LOGS_DIR="$HOME_DIR/logs"
MANIFEST_URL="$STORAGE/$MANIFEST_DIR/core.json"
INSTALL_SERVICE="${TOMAT_INSTALL_SERVICE:-1}"
INSTALL_BIND_ALL="${TOMAT_INSTALL_BIND_ALL:-0}"

ADMIN_TOKEN_FILE="$HOME_DIR/.admin-token"
ADMIN_PASSWORD_FILE="$HOME_DIR/.admin-password"
SETTINGS_FILE="$HOME_DIR/settings.json"
INSTALLED_BIN="$BIN_DIR/tomat-core$CHANNEL_SUFFIX"
# launchd label / systemd unit, suffixed per channel so multiple channels
# register distinct OS services. Stable keeps the bare names.
SERVICE_LABEL_ID="au.tomat.core$CHANNEL_SUFFIX"
SYSTEMD_UNIT="tomat-core$CHANNEL_SUFFIX"

# Resolve sha-256 command up front so all rows use the same one.
SHA_CMD="sha256sum"
if ! command -v sha256sum >/dev/null 2>&1; then
  if command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
  else
    SHA_CMD=""
  fi
fi

# --- prerequisites (pre-UI; if these fail we can't even draw the UI) ------

# gzip is load-bearing: core binary, workers, and helpers ship gzip-compressed
# and are decompressed before sha256 verification.
for cmd in curl jq gzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'error: missing required command: %s\n' "$cmd" >&2
    printf 'hint:  install %s and re-run the installer\n' "$cmd" >&2
    exit 1
  fi
done
if [ -z "$SHA_CMD" ]; then
  printf 'error: missing required command: sha256sum (or shasum)\n' >&2
  printf 'hint:  install coreutils or perl (shasum) and re-run\n' >&2
  exit 1
fi

# Committed Ed25519 signing public key (base64 raw key), kept in sync with
# packages/tomat-core/data/signing-keys.json (a test guards the match). Used to
# verify the manifest signature before trusting any download URL or hash.
TOMAT_SIGNING_PUBKEY_B64="KghrHOIqu76Hpl/xX8RHUuDA2n1NGCOj9gD1Jrn5H+M="

# Resolve an OpenSSL with Ed25519 raw-verify support (`pkeyutl -rawin`, added in
# OpenSSL 3.0). macOS ships LibreSSL, which lacks it; Homebrew's openssl@3 has
# it. Required: without signature verification a MITM of the storage origin
# could serve attacker-chosen binaries.
OPENSSL_CMD=""
for _cand in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl; do
  if command -v "$_cand" >/dev/null 2>&1 && "$_cand" version 2>/dev/null | grep -qE '^OpenSSL [3-9]'; then
    OPENSSL_CMD="$_cand"
    break
  fi
done
if [ -z "$OPENSSL_CMD" ]; then
  printf 'error: OpenSSL 3.x is required to verify the release signature\n' >&2
  printf 'hint:  install openssl (macOS: brew install openssl@3) and re-run\n' >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$WORKERS_DIR" "$EXTENSIONS_DIR" "$STAGING_DIR" "$LOGS_DIR"

# --- helper: figure out the platform-specific service label for action 7 --

uname_os="$(uname -s 2>/dev/null || echo unknown)"

if [ "$INSTALL_SERVICE" = "1" ] && [ "$uname_os" = "Darwin" ]; then
  SERVICE_LABEL="Installing launchd agent at ~/Library/LaunchAgents/$SERVICE_LABEL_ID.plist"
elif [ "$INSTALL_SERVICE" = "1" ] && [ "$uname_os" = "Linux" ]; then
  # We don't yet know whether systemd is available -- but we can probe now
  # and pick the label honestly.
  if systemctl --user --version >/dev/null 2>&1; then
    SERVICE_HAS_SYSTEMD=1
    SERVICE_LABEL="Installing systemd user unit at ~/.config/systemd/user/$SYSTEMD_UNIT.service"
  else
    SERVICE_HAS_SYSTEMD=0
    SERVICE_LABEL="Starting core in background (systemd not available, used nohup)"
  fi
else
  SERVICE_HAS_SYSTEMD=0
  SERVICE_LABEL="Starting core in background (nohup)"
fi
# Default for non-Linux paths so the variable is always set.
: "${SERVICE_HAS_SYSTEMD:=0}"

# --- admin password prompt (interactive installs only) --------------------

# The admin password lets an already-paired client mint pairing codes and
# revoke devices remotely, without reading the admin token off this machine.
# We ask for it up front (before the live progress UI starts) so the rest of
# the install runs unattended, then set it on the core once it is running
# (below, just before minting the first code). Two reads guard against typos.
#
# We read from /dev/tty, not stdin: this script is itself piped in via
# `curl | bash`, so stdin is the script. When there is no controlling
# terminal (e.g. the client-driven install), we skip the prompt and the
# client sets the password through the API afterward. Skipped too when a
# password is already on disk (re-install).
ADMIN_PW=""
if [ ! -s "$ADMIN_PASSWORD_FILE" ] && [ -r /dev/tty ]; then
  printf '\n%s\n' "Set an admin password for tomat-core." > /dev/tty
  printf '%s\n\n' "You'll need it to pair new devices remotely, so remember it." > /dev/tty
  while :; do
    printf 'Admin password (min 8 chars): ' > /dev/tty
    IFS= read -rs ADMIN_PW < /dev/tty
    printf '\n' > /dev/tty
    printf 'Confirm admin password: ' > /dev/tty
    IFS= read -rs ADMIN_PW_CONFIRM < /dev/tty
    printf '\n' > /dev/tty
    if [ "$ADMIN_PW" != "$ADMIN_PW_CONFIRM" ]; then
      printf '%s\n' "Passwords did not match. Try again." > /dev/tty
      ADMIN_PW=""
      continue
    fi
    if [ "${#ADMIN_PW}" -lt 8 ]; then
      printf '%s\n' "Password must be at least 8 characters. Try again." > /dev/tty
      ADMIN_PW=""
      continue
    fi
    break
  done
  ADMIN_PW_CONFIRM=""
fi

# --- begin UI -------------------------------------------------------------

ui_init "tomat-core installer"

# Register every row up front so the cursor knows the total height. The
# settings.json row is conditional on TOMAT_INSTALL_BIND_ALL=1.
IDX_HOST=$(ui_action_add "Detecting host")
IDX_MANIFEST=$(ui_action_add "Fetching manifest from get.au.tomat.ing")
IDX_BIN=$(ui_action_add "Installing core binary to $INSTALLED_BIN")
IDX_WORKERS=$(ui_action_add "Installing workers to $WORKERS_DIR/")
IDX_HELPERS=$(ui_action_add "Installing helpers to $BIN_DIR/")
# Built-in extension is CDN-distributed for stable/latest; dev sources it from the
# codebase at runtime, so there's nothing to fetch here.
IDX_EXTENSION=-1
if [ "$TOMAT_CHANNEL" != "dev" ]; then
  IDX_EXTENSION=$(ui_action_add "Planting built-in extension in $EXTENSIONS_DIR/")
fi
IDX_TOKEN=$(ui_action_add "Writing admin token to $ADMIN_TOKEN_FILE")
IDX_SETTINGS=-1
if [ "$INSTALL_BIND_ALL" = "1" ]; then
  IDX_SETTINGS=$(ui_action_add "Seeding $SETTINGS_FILE")
fi
IDX_SERVICE=$(ui_action_add "$SERVICE_LABEL")
IDX_PASSWORD=-1
if [ -n "$ADMIN_PW" ]; then
  IDX_PASSWORD=$(ui_action_add "Setting admin password")
fi
IDX_PAIR=$(ui_action_add "Minting pairing code at https://127.0.0.1:$CORE_PORT")

# --- action 1: detect host -----------------------------------------------

ui_action_start "$IDX_HOST" "Detecting host"

case "$(uname -s)" in
  Darwin) HOST_OS="apple-darwin" ;;
  Linux)  HOST_OS="unknown-linux-gnu" ;;
  *)
    ui_die "Unsupported OS or architecture" \
      "Detected: $(uname -s)/$(uname -m)" \
      "tomat targets darwin/linux on x86_64/aarch64"
    ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH="x86_64" ;;
  aarch64|arm64) HOST_ARCH="aarch64" ;;
  *)
    ui_die "Unsupported OS or architecture" \
      "Detected: $(uname -s)/$(uname -m)" \
      "tomat targets darwin/linux on x86_64/aarch64"
    ;;
esac
TRIPLE="${HOST_ARCH}-${HOST_OS}"

ui_action_done "$IDX_HOST" "($TRIPLE)"

# --- action 2: fetch manifest --------------------------------------------

ui_action_start "$IDX_MANIFEST" "Fetching manifest from get.au.tomat.ing"

MANIFEST_TMP="$STAGING_DIR/core-manifest-$$.json"
_ui_track_staging "$MANIFEST_TMP"

MANIFEST_HTTP_STATUS=0
MANIFEST_CURL_RC=0
MANIFEST_HTTP_STATUS="$(
  curl -fsSL -o "$MANIFEST_TMP" -w '%{http_code}' "$MANIFEST_URL" 2>/dev/null
)" || MANIFEST_CURL_RC=$?

if [ "$MANIFEST_CURL_RC" -ne 0 ]; then
  case "$MANIFEST_CURL_RC" in
    6|7)
      ui_die "Network error reaching get.au.tomat.ing" \
        "curl exit $MANIFEST_CURL_RC" \
        "check internet connectivity, then re-run"
      ;;
    22)
      # HTTP 4xx/5xx -- try to get the status code from the body filename or
      # default to the empty status.
      if [ "$MANIFEST_HTTP_STATUS" = "404" ] || [ -z "$MANIFEST_HTTP_STATUS" ]; then
        ui_die "Manifest not found at $MANIFEST_URL" \
          "HTTP 404" \
          "the storage origin may be misconfigured; report at github.com/rzkyif/tomat/issues"
      else
        ui_die "Storage returned $MANIFEST_HTTP_STATUS" \
          "" \
          "transient outage at R2; try again in a few minutes"
      fi
      ;;
    *)
      ui_die "Network error reaching get.au.tomat.ing" \
        "curl exit $MANIFEST_CURL_RC" \
        "check internet connectivity, then re-run"
      ;;
  esac
fi

if [ ! -s "$MANIFEST_TMP" ]; then
  ui_die "Empty manifest from $MANIFEST_URL" \
    "" \
    "transient outage at R2; try again in a few minutes"
fi

MANIFEST_JSON="$(cat "$MANIFEST_TMP")"
rm -f "$MANIFEST_TMP"

if ! VERSION="$(printf '%s' "$MANIFEST_JSON" | jq -er '.version // empty' 2>/dev/null)"; then
  ui_die "Could not parse manifest JSON" \
    "" \
    "redirected or proxy interception?"
fi
if [ -z "$VERSION" ]; then
  ui_die "Manifest missing version field" \
    "" \
    "the storage origin may be misconfigured"
fi

# Authenticate the manifest before trusting any URL/sha256 in it. The signature
# covers canonicalize(manifest minus `signature`) (matching the core's own
# verifier in packages/tomat-core/src/update/self-updater.ts), which `jq -Sjc`
# reproduces byte-for-byte. Fail closed: a tampered or unsigned manifest aborts.
SIG_PEM="$STAGING_DIR/tomat-pubkey-$$.pem"
SIG_CANON="$STAGING_DIR/tomat-canon-$$.bin"
SIG_RAW="$STAGING_DIR/tomat-sig-$$.bin"
printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' \
  "$TOMAT_SIGNING_PUBKEY_B64" >"$SIG_PEM"
printf '%s' "$MANIFEST_JSON" | jq -Sjc 'del(.signature)' >"$SIG_CANON" 2>/dev/null
printf '%s' "$MANIFEST_JSON" | jq -r '.signature // empty' | "$OPENSSL_CMD" base64 -d -A >"$SIG_RAW" 2>/dev/null
if ! "$OPENSSL_CMD" pkeyutl -verify -pubin -inkey "$SIG_PEM" -rawin -in "$SIG_CANON" -sigfile "$SIG_RAW" >/dev/null 2>&1; then
  rm -f "$SIG_PEM" "$SIG_CANON" "$SIG_RAW"
  ui_die "Manifest signature verification failed" \
    "" \
    "the manifest may have been tampered with in transit; aborting"
fi
rm -f "$SIG_PEM" "$SIG_CANON" "$SIG_RAW"

URL="$(printf '%s' "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.binaries[] | select(.triple==$t) | .url' 2>/dev/null || true)"
SHA256="$(printf '%s' "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.binaries[] | select(.triple==$t) | .sha256' 2>/dev/null || true)"
if [ -z "$URL" ] || [ -z "$SHA256" ]; then
  ui_die "No binary for $TRIPLE in manifest" \
    "" \
    "your platform may not be supported yet"
fi

ui_action_done "$IDX_MANIFEST" "(v$VERSION)"

# --- action 3: install core binary ---------------------------------------

# Pre-check: does the on-disk binary already match?
EXISTING_OK=0
if [ -f "$INSTALLED_BIN" ]; then
  EXISTING_SHA="$($SHA_CMD "$INSTALLED_BIN" 2>/dev/null | awk '{print $1}')"
  if [ "$EXISTING_SHA" = "$SHA256" ]; then
    EXISTING_OK=1
  fi
fi

if [ "$EXISTING_OK" = "1" ]; then
  ui_action_skip "$IDX_BIN" "(already current)"
else
  ui_action_start "$IDX_BIN" "Installing core binary to $INSTALLED_BIN" "(downloading)"

  BIN_TMP="$STAGING_DIR/tomat-core-$VERSION-$$"
  _ui_track_staging "$BIN_TMP"
  _ui_track_staging "$BIN_TMP.gz"

  BIN_CURL_RC=0
  curl -fsSL -o "$BIN_TMP.gz" "$URL" 2>/dev/null || BIN_CURL_RC=$?
  if [ "$BIN_CURL_RC" -ne 0 ]; then
    ui_die "Download interrupted" \
      "curl exit $BIN_CURL_RC fetching $URL" \
      "re-run; partial files were cleaned up"
  fi

  # The artifact ships gzip-compressed; sha256 is over the decompressed binary.
  ui_action_update "$IDX_BIN" "(decompressing)"
  if ! gzip -dc "$BIN_TMP.gz" > "$BIN_TMP" 2>/dev/null; then
    ui_die "Could not decompress core binary" \
      "gzip -d failed on $BIN_TMP.gz" \
      "network corruption is the usual cause; re-run"
  fi
  rm -f "$BIN_TMP.gz"

  ui_action_update "$IDX_BIN" "(verifying)"
  GOT="$($SHA_CMD "$BIN_TMP" | awk '{print $1}')"
  if [ "$GOT" != "$SHA256" ]; then
    ui_die "sha256 mismatch on core binary" \
      "want $SHA256, got $GOT" \
      "network corruption is the usual cause; re-run"
  fi

  ui_action_update "$IDX_BIN" "(installing)"
  if ! mv -f "$BIN_TMP" "$INSTALLED_BIN" 2>/dev/null; then
    if [ ! -w "$BIN_DIR" ]; then
      ui_die "Permission denied writing to $BIN_DIR/" \
        "" \
        "check ownership of ~/.tomat"
    fi
    ui_die "Could not install core binary" \
      "mv $BIN_TMP -> $INSTALLED_BIN failed" \
      "check disk space and ownership of $BIN_DIR/"
  fi
  chmod 0755 "$INSTALLED_BIN"

  # Pretty file size for the detail.
  BIN_BYTES="$(wc -c < "$INSTALLED_BIN" 2>/dev/null | tr -d ' ' || echo 0)"
  BIN_MB="$((BIN_BYTES / 1024 / 1024))"
  ui_action_done "$IDX_BIN" "(${BIN_MB} MB)"
fi

# --- action 4: install workers -------------------------------------------

WORKERS_COUNT="$(printf '%s' "$MANIFEST_JSON" | jq -r '.workers // [] | length')"
# `jq length` is always a non-negative integer; guard against non-numeric jq
# output (e.g. a malformed manifest) rather than the impossible negative case.
case "$WORKERS_COUNT" in
'' | *[!0-9]*) WORKERS_COUNT=0 ;;
esac

# Pre-check: are all workers already on disk and matching?
WORKERS_ALL_OK=1
if [ "$WORKERS_COUNT" -gt 0 ]; then
  i=0
  while [ "$i" -lt "$WORKERS_COUNT" ]; do
    W_NAME="$(printf '%s' "$MANIFEST_JSON" | jq -r ".workers[$i].name")"
    W_SHA="$(printf '%s' "$MANIFEST_JSON" | jq -r ".workers[$i].sha256")"
    W_PATH="$WORKERS_DIR/$W_NAME"
    if [ ! -f "$W_PATH" ]; then
      WORKERS_ALL_OK=0
      break
    fi
    W_GOT="$($SHA_CMD "$W_PATH" 2>/dev/null | awk '{print $1}')"
    if [ "$W_GOT" != "$W_SHA" ]; then
      WORKERS_ALL_OK=0
      break
    fi
    i=$((i + 1))
  done
else
  # No workers in manifest at all -- nothing to do.
  WORKERS_ALL_OK=1
fi

if [ "$WORKERS_ALL_OK" = "1" ]; then
  ui_action_skip "$IDX_WORKERS" "(${WORKERS_COUNT}/${WORKERS_COUNT} already current)"
else
  ui_action_start "$IDX_WORKERS" "Installing workers to $WORKERS_DIR/" "(0/${WORKERS_COUNT})"

  i=0
  while [ "$i" -lt "$WORKERS_COUNT" ]; do
    W_NAME="$(printf '%s' "$MANIFEST_JSON" | jq -r ".workers[$i].name")"
    W_URL="$(printf '%s' "$MANIFEST_JSON" | jq -r ".workers[$i].url")"
    W_SHA="$(printf '%s' "$MANIFEST_JSON" | jq -r ".workers[$i].sha256")"
    W_PATH="$WORKERS_DIR/$W_NAME"
    W_TMP="$STAGING_DIR/$W_NAME-$VERSION-$$"

    # Skip individual workers that are already correct on disk.
    W_NEED=1
    if [ -f "$W_PATH" ]; then
      W_GOT="$($SHA_CMD "$W_PATH" 2>/dev/null | awk '{print $1}')"
      if [ "$W_GOT" = "$W_SHA" ]; then
        W_NEED=0
      fi
    fi

    ui_action_update "$IDX_WORKERS" "($((i + 1))/${WORKERS_COUNT} $W_NAME)"

    if [ "$W_NEED" = "1" ]; then
      _ui_track_staging "$W_TMP"
      _ui_track_staging "$W_TMP.gz"
      W_CURL_RC=0
      curl -fsSL -o "$W_TMP.gz" "$W_URL" 2>/dev/null || W_CURL_RC=$?
      if [ "$W_CURL_RC" -ne 0 ]; then
        ui_die "Download interrupted" \
          "curl exit $W_CURL_RC fetching worker $W_NAME" \
          "re-run; partial files were cleaned up"
      fi
      if ! gzip -dc "$W_TMP.gz" > "$W_TMP" 2>/dev/null; then
        ui_die "Could not decompress worker $W_NAME" \
          "gzip -d failed on $W_TMP.gz" \
          "network corruption is the usual cause; re-run"
      fi
      rm -f "$W_TMP.gz"
      W_GOT="$($SHA_CMD "$W_TMP" | awk '{print $1}')"
      if [ "$W_GOT" != "$W_SHA" ]; then
        ui_die "sha256 mismatch on worker $W_NAME" \
          "want $W_SHA, got $W_GOT" \
          "network corruption is the usual cause; re-run"
      fi
      if ! mv -f "$W_TMP" "$W_PATH" 2>/dev/null; then
        ui_die "Permission denied writing to $WORKERS_DIR/" \
          "could not install $W_NAME" \
          "check ownership of ~/.tomat"
      fi
    fi

    i=$((i + 1))
  done

  ui_action_done "$IDX_WORKERS" "(${WORKERS_COUNT}/${WORKERS_COUNT})"
fi

# --- action 5: install helpers -------------------------------------------

HELPERS_COUNT="$(printf '%s' "$MANIFEST_JSON" | jq -r '.helpers // [] | length')"
# Guard against non-numeric jq output (malformed manifest), not the impossible
# negative length.
case "$HELPERS_COUNT" in
'' | *[!0-9]*) HELPERS_COUNT=0 ;;
esac

# Count helpers matching our triple. Compute the indices of matching ones
# (Bash 3.2 has no arrays we want to rely on, so we build a space-separated
# list of indices).
HELPER_INDICES=""
HELPERS_MATCHING=0
i=0
while [ "$i" -lt "$HELPERS_COUNT" ]; do
  H_TRIPLE="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$i].triple")"
  if [ "$H_TRIPLE" = "$TRIPLE" ]; then
    HELPER_INDICES="$HELPER_INDICES $i"
    HELPERS_MATCHING=$((HELPERS_MATCHING + 1))
  fi
  i=$((i + 1))
done

if [ "$HELPERS_MATCHING" = "0" ]; then
  ui_action_skip "$IDX_HELPERS" "(no helper for this triple)"
else
  # Pre-check: every matching helper already correct?
  HELPERS_ALL_OK=1
  for hi in $HELPER_INDICES; do
    H_NAME="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$hi].name")"
    H_SHA="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$hi].sha256")"
    H_PATH="$BIN_DIR/$H_NAME"
    if [ ! -f "$H_PATH" ]; then
      HELPERS_ALL_OK=0
      break
    fi
    H_GOT="$($SHA_CMD "$H_PATH" 2>/dev/null | awk '{print $1}')"
    if [ "$H_GOT" != "$H_SHA" ]; then
      HELPERS_ALL_OK=0
      break
    fi
  done

  if [ "$HELPERS_ALL_OK" = "1" ]; then
    ui_action_skip "$IDX_HELPERS" "(${HELPERS_MATCHING}/${HELPERS_MATCHING} already current)"
  else
    ui_action_start "$IDX_HELPERS" "Installing helpers to $BIN_DIR/" "(0/${HELPERS_MATCHING})"

    j=0
    for hi in $HELPER_INDICES; do
      H_NAME="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$hi].name")"
      H_URL="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$hi].url")"
      H_SHA="$(printf '%s' "$MANIFEST_JSON" | jq -r ".helpers[$hi].sha256")"
      H_PATH="$BIN_DIR/$H_NAME"
      H_TMP="$STAGING_DIR/$H_NAME-$VERSION-$$"

      H_NEED=1
      if [ -f "$H_PATH" ]; then
        H_GOT="$($SHA_CMD "$H_PATH" 2>/dev/null | awk '{print $1}')"
        if [ "$H_GOT" = "$H_SHA" ]; then
          H_NEED=0
        fi
      fi

      j=$((j + 1))
      ui_action_update "$IDX_HELPERS" "(${j}/${HELPERS_MATCHING} $H_NAME)"

      if [ "$H_NEED" = "1" ]; then
        _ui_track_staging "$H_TMP"
        _ui_track_staging "$H_TMP.gz"
        H_CURL_RC=0
        curl -fsSL -o "$H_TMP.gz" "$H_URL" 2>/dev/null || H_CURL_RC=$?
        if [ "$H_CURL_RC" -ne 0 ]; then
          ui_die "Download interrupted" \
            "curl exit $H_CURL_RC fetching helper $H_NAME" \
            "re-run; partial files were cleaned up"
        fi
        if ! gzip -dc "$H_TMP.gz" > "$H_TMP" 2>/dev/null; then
          ui_die "Could not decompress helper $H_NAME" \
            "gzip -d failed on $H_TMP.gz" \
            "network corruption is the usual cause; re-run"
        fi
        rm -f "$H_TMP.gz"
        H_GOT="$($SHA_CMD "$H_TMP" | awk '{print $1}')"
        if [ "$H_GOT" != "$H_SHA" ]; then
          ui_die "sha256 mismatch on helper $H_NAME" \
            "want $H_SHA, got $H_GOT" \
            "network corruption is the usual cause; re-run"
        fi
        if ! mv -f "$H_TMP" "$H_PATH" 2>/dev/null; then
          ui_die "Permission denied writing to $BIN_DIR/" \
            "could not install $H_NAME" \
            "check ownership of ~/.tomat"
        fi
        chmod 0755 "$H_PATH"
      fi
    done

    ui_action_done "$IDX_HELPERS" "(${HELPERS_MATCHING}/${HELPERS_MATCHING})"
  fi
fi

# --- action 5b: built-in extension -----------------------------------------
# Download the CDN-distributed built-in extension and PLANT its verified tarball so
# core can install it on first boot without re-downloading the tarball. Core still
# re-verifies the planted tarball against the signed manifest before extracting it.
# Planting is an OPTIONAL optimization: EVERY failure here is non-fatal (we skip and
# core fetches + verifies + seeds the built-in itself), so a bad/tampered extension
# manifest or a flaky CDN never aborts the core install.

if [ "$IDX_EXTENSION" != "-1" ]; then
  # Plant the tarball AND its signed manifest so core installs the built-in fully
  # offline on first boot (it re-verifies the manifest signature + tarball sha256,
  # then extracts - no boot-time fetch). Keep these filenames in sync with
  # builtin-seed.ts (PLANTED_TARBALL / PLANTED_MANIFEST).
  TK_DEST="$EXTENSIONS_DIR/.tomat-builtin.tgz"
  TK_MANIFEST_DEST="$EXTENSIONS_DIR/.tomat-builtin.json"
  if [ -f "$TK_DEST" ] && [ -f "$TK_MANIFEST_DEST" ]; then
    ui_action_skip "$IDX_EXTENSION" "(already present)"
  else
    TK_MANIFEST="$(curl -fsSL "$STORAGE/$MANIFEST_DIR/extension.json" 2>/dev/null || true)"
    if [ -z "$TK_MANIFEST" ]; then
      ui_action_skip "$IDX_EXTENSION" "(manifest unavailable; core will seed)"
    else
      ui_action_start "$IDX_EXTENSION" "Planting built-in extension in $EXTENSIONS_DIR/" "(reading)"

      # Read the tarball location + hash from extension.json. We do NOT verify the
      # manifest signature here: core re-verifies the planted manifest's Ed25519
      # signature AND the tarball's sha256 OFFLINE before installing on first boot
      # (readPlantedManifest + the installer), so core is the single trust gate. A
      # MITM that swaps both manifest and tarball is rejected there, never seeded.
      # The sha256 check below is only a transport-corruption guard.
      TK_URL="$(printf '%s' "$TK_MANIFEST" | jq -r '.tarballUrl // empty' 2>/dev/null || true)"
      TK_SHA="$(printf '%s' "$TK_MANIFEST" | jq -r '.sha256 // empty' 2>/dev/null || true)"

      if [ -z "$TK_URL" ] || [ -z "$TK_SHA" ]; then
        ui_action_skip "$IDX_EXTENSION" "(manifest incomplete; core will seed)"
      else
        ui_action_update "$IDX_EXTENSION" "(downloading)"
        TK_TMP="$STAGING_DIR/builtin-extension-$$.tgz"
        _ui_track_staging "$TK_TMP"
        if ! curl -fsSL -o "$TK_TMP" "$TK_URL" 2>/dev/null; then
          rm -f "$TK_TMP"
          ui_action_skip "$IDX_EXTENSION" "(download failed; core will seed)"
        else
          TK_GOT="$($SHA_CMD "$TK_TMP" 2>/dev/null | awk '{print $1}')"
          if [ "$TK_GOT" != "$TK_SHA" ]; then
            rm -f "$TK_TMP"
            ui_action_skip "$IDX_EXTENSION" "(checksum mismatch; core will seed)"
          elif ! mv -f "$TK_TMP" "$TK_DEST" 2>/dev/null; then
            rm -f "$TK_TMP"
            ui_action_skip "$IDX_EXTENSION" "(could not place; core will seed)"
          elif ! printf '%s' "$TK_MANIFEST" > "$TK_MANIFEST_DEST" 2>/dev/null; then
            # The signed manifest must sit beside the tarball, or core can't verify
            # + install offline. Drop the tarball too so the next run re-plants both.
            rm -f "$TK_DEST" "$TK_MANIFEST_DEST"
            ui_action_skip "$IDX_EXTENSION" "(could not place; core will seed)"
          else
            # Planted as-is; on first boot core re-verifies the manifest signature +
            # tarball sha256 and extracts it, with no network access.
            ui_action_done "$IDX_EXTENSION" "(planted)"
          fi
        fi
      fi
    fi
  fi
fi

# --- action 6: admin token -----------------------------------------------

if [ -s "$ADMIN_TOKEN_FILE" ]; then
  ui_action_skip "$IDX_TOKEN" "(already present)"
else
  ui_action_start "$IDX_TOKEN" "Writing admin token to $ADMIN_TOKEN_FILE"

  if [ ! -r /dev/urandom ]; then
    ui_die "No entropy source available" \
      "/dev/urandom is missing or unreadable" \
      "extremely rare; check /dev/urandom"
  fi
  if ! command -v xxd >/dev/null 2>&1; then
    ui_die "Missing xxd command" \
      "" \
      "install vim-common or busybox"
  fi

  if ! head -c 16 /dev/urandom | xxd -p -c 256 > "$ADMIN_TOKEN_FILE" 2>/dev/null; then
    ui_die "Permission denied writing $ADMIN_TOKEN_FILE" \
      "" \
      "check ownership of $HOME_DIR/"
  fi
  chmod 0600 "$ADMIN_TOKEN_FILE"

  ui_action_done "$IDX_TOKEN" "(0600)"
fi

# --- action 6b: seed settings.json ---------------------------------------

if [ "$IDX_SETTINGS" != "-1" ]; then
  if [ -e "$SETTINGS_FILE" ]; then
    ui_action_skip "$IDX_SETTINGS" "(already present)"
  else
    ui_action_start "$IDX_SETTINGS" "Seeding $SETTINGS_FILE"
    if ! printf '%s\n' '{"server.bindHost":"0.0.0.0"}' > "$SETTINGS_FILE" 2>/dev/null; then
      ui_die "Permission denied writing $SETTINGS_FILE" \
        "" \
        "check ownership of $HOME_DIR/"
    fi
    ui_action_done "$IDX_SETTINGS" "(server.bindHost=0.0.0.0)"
  fi
fi

# --- action 7: service registration --------------------------------------

# Snapshot whether the core is already running before we touch anything,
# so we can settle the row as [~] only when nothing user-visible happened.
SERVICE_ALREADY_RUNNING=0
if command -v pgrep >/dev/null 2>&1; then
  if pgrep -f "$INSTALLED_BIN" >/dev/null 2>&1; then
    SERVICE_ALREADY_RUNNING=1
  fi
fi

if [ "$INSTALL_SERVICE" != "1" ]; then
  # Nohup branch.
  ui_action_start "$IDX_SERVICE" "$SERVICE_LABEL"
  TOMAT_CHANNEL="$TOMAT_CHANNEL" nohup "$INSTALLED_BIN" \
    >>"$LOGS_DIR/core.stdout.log" \
    2>>"$LOGS_DIR/core.stderr.log" &
  NOHUP_PID=$!
  disown "$NOHUP_PID" 2>/dev/null || true
  ui_action_done "$IDX_SERVICE" "(pid $NOHUP_PID)"

elif [ "$uname_os" = "Darwin" ]; then
  # macOS launchd branch.
  ui_action_start "$IDX_SERVICE" "$SERVICE_LABEL"

  PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL_ID.plist"
  mkdir -p "$(dirname "$PLIST")"

  # Determine whether the plist already pointed at the right binary AND the
  # service was already running. If so, we treat the re-load as a no-op.
  PLIST_UNCHANGED=0
  if [ -f "$PLIST" ] && grep -q "<string>$INSTALLED_BIN</string>" "$PLIST" 2>/dev/null; then
    if launchctl list "$SERVICE_LABEL_ID" >/dev/null 2>&1; then
      PLIST_UNCHANGED=1
    fi
  fi

  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>$SERVICE_LABEL_ID</string>
  <key>ProgramArguments</key><array><string>$INSTALLED_BIN</string></array>
  <key>EnvironmentVariables</key><dict><key>TOMAT_CHANNEL</key><string>$TOMAT_CHANNEL</string></dict>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>$LOGS_DIR/core.stdout.log</string>
  <key>StandardErrorPath</key><string>$LOGS_DIR/core.stderr.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$PLIST" 2>/dev/null || true
  LOAD_RC=0
  launchctl load "$PLIST" 2>/dev/null || LOAD_RC=$?
  if [ "$LOAD_RC" -ne 0 ]; then
    ui_die "launchctl load failed (exit $LOAD_RC)" \
      "$PLIST" \
      "inspect the plist; another user may own /Library/LaunchAgents"
  fi

  if [ "$PLIST_UNCHANGED" = "1" ] && [ "$SERVICE_ALREADY_RUNNING" = "1" ]; then
    ui_action_skip "$IDX_SERVICE" "(reloaded)"
  else
    ui_action_done "$IDX_SERVICE" "(loaded)"
  fi

elif [ "$uname_os" = "Linux" ] && [ "$SERVICE_HAS_SYSTEMD" = "1" ]; then
  # Linux systemd-user branch.
  ui_action_start "$IDX_SERVICE" "$SERVICE_LABEL"

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT="$UNIT_DIR/$SYSTEMD_UNIT.service"

  # Detect whether the existing unit file already points at the same binary
  # AND the service is currently active. If so, we treat the reload as a
  # no-op so the row settles [~] instead of [✓].
  UNIT_UNCHANGED=0
  if [ -f "$UNIT" ] && grep -q "^ExecStart=$INSTALLED_BIN\$" "$UNIT" 2>/dev/null; then
    if systemctl --user is-active --quiet "$SYSTEMD_UNIT.service" 2>/dev/null; then
      UNIT_UNCHANGED=1
    fi
  fi

  cat >"$UNIT" <<UNIT
[Unit]
Description=$SYSTEMD_UNIT
Wants=network-online.target
After=network-online.target

[Service]
Environment=TOMAT_CHANNEL=$TOMAT_CHANNEL
ExecStart=$INSTALLED_BIN
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOGS_DIR/core.stdout.log
StandardError=append:$LOGS_DIR/core.stderr.log

[Install]
WantedBy=default.target
UNIT

  if ! systemctl --user daemon-reload 2>/dev/null; then
    ui_die "systemctl --user daemon-reload failed" \
      "" \
      "re-run with TOMAT_INSTALL_SERVICE=0 to start core via nohup"
  fi
  if ! systemctl --user enable --now "$SYSTEMD_UNIT.service" 2>/dev/null; then
    ui_die "systemctl --user enable failed" \
      "" \
      "re-run with TOMAT_INSTALL_SERVICE=0 to start core via nohup"
  fi

  if [ "$UNIT_UNCHANGED" = "1" ] && [ "$SERVICE_ALREADY_RUNNING" = "1" ]; then
    ui_action_skip "$IDX_SERVICE" "(reloaded)"
  else
    ui_action_done "$IDX_SERVICE" "(enabled)"
  fi

else
  # Linux fallback: no user systemd available. Plan calls this out
  # explicitly as non-fatal; we just nohup the binary.
  ui_action_start "$IDX_SERVICE" "$SERVICE_LABEL"
  TOMAT_CHANNEL="$TOMAT_CHANNEL" nohup "$INSTALLED_BIN" \
    >>"$LOGS_DIR/core.stdout.log" \
    2>>"$LOGS_DIR/core.stderr.log" &
  NOHUP_PID=$!
  disown "$NOHUP_PID" 2>/dev/null || true
  ui_action_done "$IDX_SERVICE" "(used nohup)"
fi

# --- action 8: mint pairing code -----------------------------------------

ui_action_start "$IDX_PAIR" "Minting pairing code at https://127.0.0.1:$CORE_PORT" "(waiting for core)"

# Poll the unauthenticated health endpoint until the freshly-started core binds
# its port. A cold start can take several seconds, so wait rather than failing
# the password-set and mint on a single early miss (the old fixed `sleep 2`).
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS -k -o /dev/null "https://127.0.0.1:$CORE_PORT/api/v1/health" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

ADMIN="$(cat "$ADMIN_TOKEN_FILE" 2>/dev/null || true)"
CODE=""
PAIR_FAILED=0

# --- action 8a: set admin password ---------------------------------------

# Set the password the user chose at the top, now that core is up. The body is
# piped via stdin (-d @-), never an argv/header, so it can't leak through `ps`.
# Authorized by the on-disk admin token over loopback (-k: self-signed cert).
if [ "$IDX_PASSWORD" != "-1" ] && [ -n "$ADMIN" ]; then
  ui_action_start "$IDX_PASSWORD" "Setting admin password"
  PW_STATUS="$(
    printf '%s' "$ADMIN_PW" | jq -Rs '{password: .}' 2>/dev/null | curl -fsS -k -o /dev/null \
      -w '%{http_code}' -X POST \
      -H "X-Admin-Token: $ADMIN" \
      -H 'Content-Type: application/json' \
      -d @- \
      "https://127.0.0.1:$CORE_PORT/api/v1/admin/password" 2>/dev/null || true
  )"
  ADMIN_PW=""
  if [ "$PW_STATUS" = "204" ]; then
    ui_action_done "$IDX_PASSWORD"
  else
    ui_action_skip "$IDX_PASSWORD" "(could not set; set it later in the client)"
  fi
fi

# Core serves HTTPS with a self-signed cert. This mint runs on the core host
# over loopback and is authenticated by the on-disk admin token, so -k (skip
# cert verification) is fine here; the client pins the cert during pairing.
# Retry a few times: the health probe above confirms the port is bound, but the
# pairing route can lag the bind by a moment on a cold start.
if [ -n "$ADMIN" ]; then
  i=0
  while [ "$i" -lt 5 ]; do
    CODE_JSON="$(curl -fsS -k -X POST \
      -H "X-Admin-Token: $ADMIN" \
      -H 'Content-Type: application/json' \
      -d '{}' \
      "https://127.0.0.1:$CORE_PORT/api/v1/pairing/codes" 2>/dev/null || true)"
    if [ -n "$CODE_JSON" ]; then
      CODE="$(printf '%s' "$CODE_JSON" | jq -r '.code // empty' 2>/dev/null || true)"
    fi
    [ -n "$CODE" ] && break
    i=$((i + 1))
    sleep 1
  done
fi

if [ -n "$CODE" ]; then
  ui_action_done "$IDX_PAIR"
else
  PAIR_FAILED=1
  ui_action_skip "$IDX_PAIR" "(could not mint; see manual instructions below)"
fi

# --- footer ---------------------------------------------------------------

if [ "$PAIR_FAILED" = "0" ]; then
  ui_finish \
    "Pairing code: $CODE" \
    "" \
    "Open tomat-client → Pair → enter:" \
    "  URL : https://127.0.0.1:$CORE_PORT   (or this host's LAN IP)" \
    "  Code: $CODE"
else
  ui_finish \
    "tomat-core installed. Mint a pairing code with:" \
    "  curl -k -X POST -H \"X-Admin-Token: \$(cat $ADMIN_TOKEN_FILE)\" \\" \
    "       -H 'Content-Type: application/json' -d '{}' \\" \
    "       https://127.0.0.1:$CORE_PORT/api/v1/pairing/codes"
fi

exit 0
