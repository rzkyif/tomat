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
#   TOMAT_INSTALL_BEHIND_PROXY
#                          "1" seeds settings.json with server.behindProxy=true
#                          for a core served through an HTTPS reverse proxy:
#                          clients then trust the proxy's real certificate when
#                          pairing instead of pinning the core's own. Must be
#                          set before the first pair. "0" (default) pins.
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
INSTALL_BEHIND_PROXY="${TOMAT_INSTALL_BEHIND_PROXY:-0}"

# Where the seed binary lands. The admin token, settings, service names, and
# extension planting are all owned by the core binary's install subcommands now.
INSTALLED_BIN="$BIN_DIR/tomat-core$CHANNEL_SUFFIX"

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
# and are decompressed before sha256 verification. jq is required too but is not
# on the hard list: default Ubuntu/Debian ship no jq, so `ensure_jq` (below)
# auto-provisions a pinned static build when it is missing rather than aborting.
for cmd in curl gzip; do
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

# Verify a raw Ed25519 signature over a payload file against the committed
# signing public key. Pure: no UI, no globals beyond OPENSSL_CMD +
# TOMAT_SIGNING_PUBKEY_B64; returns 0 when valid, non-zero otherwise, so callers
# decide how to react (the install flow below maps failure to ui_die; the
# self-test maps it to an exit code). Single source of the verify crypto, shared
# by the real install path and TOMAT_SELFTEST so the test exercises the actual
# logic rather than a copy.
ed25519_verify_file() {
  _ev_payload="$1"
  _ev_sig_raw="$2"
  _ev_pem="$(mktemp 2>/dev/null || mktemp -t tomat-verify-pem)"
  printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' \
    "$TOMAT_SIGNING_PUBKEY_B64" >"$_ev_pem"
  _ev_rc=0
  "$OPENSSL_CMD" pkeyutl -verify -pubin -inkey "$_ev_pem" -rawin \
    -in "$_ev_payload" -sigfile "$_ev_sig_raw" >/dev/null 2>&1 || _ev_rc=$?
  rm -f "$_ev_pem"
  return "$_ev_rc"
}

# Ensure `jq` is available, auto-provisioning a pinned static build when the host
# has none. jq parses the manifest AND reproduces the canonical bytes the release
# signature covers (jq -Sjc 'del(.signature)'), so it is load-bearing, yet
# default Ubuntu/Debian do not ship it. Rather than abort those users, fetch the
# official static jq for this platform, verify it against a committed sha256, and
# prepend it to PATH so every `jq` call site below resolves it unchanged. The
# download lives in a temp dir for this run only (no sudo, no PATH persistence).
# Runs only on the real install path (after the offline self-test has exited), so
# the self-test stays network-free and uses the host's own jq.
JQ_VERSION="jq-1.7.1"
JQ_BASE_URL="https://github.com/jqlang/jq/releases/download/$JQ_VERSION"
ensure_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  _jq_os="$(uname -s 2>/dev/null || echo unknown)"
  _jq_arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$_jq_os/$_jq_arch" in
    Linux/x86_64)
      _jq_asset="jq-linux-amd64"
      _jq_sha="5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5" ;;
    Linux/aarch64 | Linux/arm64)
      _jq_asset="jq-linux-arm64"
      _jq_sha="4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5" ;;
    Darwin/x86_64)
      _jq_asset="jq-macos-amd64"
      _jq_sha="4155822bbf5ea90f5c79cf254665975eb4274d426d0709770c21774de5407443" ;;
    Darwin/arm64)
      _jq_asset="jq-macos-arm64"
      _jq_sha="0bbe619e663e0de2c550be2fe0d240d076799d6f8a652b70fa04aea8a8362e8a" ;;
    *)
      printf 'error: jq is required but not installed\n' >&2
      printf 'hint:  install jq (e.g. "sudo apt install jq" or "brew install jq") and re-run\n' >&2
      exit 1 ;;
  esac
  _jq_dir="$(mktemp -d 2>/dev/null || mktemp -d -t tomat-jq)"
  _jq_bin="$_jq_dir/jq"
  printf 'jq not found; fetching pinned static jq (%s)...\n' "$_jq_asset" >&2
  if ! curl -fsSL "$JQ_BASE_URL/$_jq_asset" -o "$_jq_bin" 2>/dev/null; then
    rm -rf "$_jq_dir"
    printf 'error: could not download jq from %s\n' "$JQ_BASE_URL/$_jq_asset" >&2
    printf 'hint:  install jq manually (e.g. "sudo apt install jq") and re-run\n' >&2
    exit 1
  fi
  _jq_shacmd="sha256sum"
  command -v sha256sum >/dev/null 2>&1 || _jq_shacmd="shasum -a 256"
  _jq_got="$($_jq_shacmd "$_jq_bin" 2>/dev/null | awk '{print $1}')"
  if [ "$_jq_got" != "$_jq_sha" ]; then
    rm -rf "$_jq_dir"
    printf 'error: downloaded jq failed sha256 verification\n' >&2
    printf '       expected %s, got %s\n' "$_jq_sha" "${_jq_got:-<none>}" >&2
    printf 'hint:  the download may be corrupt or tampered; re-run or install jq manually\n' >&2
    exit 1
  fi
  chmod +x "$_jq_bin"
  PATH="$_jq_dir:$PATH"
  export PATH
}

# --- offline self-test (exercised by scripts/install/verify.test.ts) ------
# When TOMAT_SELFTEST is set, verify a LOCAL manifest with the exact
# canonicalize(minus .signature) + embedded-signature + ed25519_verify_file the
# install flow uses, then exit before any network/install. The core manifest
# carries an EMBEDDED `signature` field (unlike the client's detached .sig), so
# this mirrors that shape. TOMAT_SELFTEST_PUBKEY_B64 overrides the committed key
# so the test can sign fixtures with an ephemeral keypair. Exits 0 when the
# signature (and optional artifact sha256) verify, non-zero (fail-closed) otherwise.
if [ -n "${TOMAT_SELFTEST:-}" ]; then
  TOMAT_SIGNING_PUBKEY_B64="${TOMAT_SELFTEST_PUBKEY_B64:-$TOMAT_SIGNING_PUBKEY_B64}"
  _st_json="$(cat "$TOMAT_SELFTEST_MANIFEST")"
  _st_canon="$(mktemp 2>/dev/null || mktemp -t tomat-selftest-canon)"
  _st_raw="$(mktemp 2>/dev/null || mktemp -t tomat-selftest-sig)"
  printf '%s' "$_st_json" | jq -Sjc 'del(.signature)' >"$_st_canon" 2>/dev/null
  printf '%s' "$_st_json" | jq -r '.signature // empty' | "$OPENSSL_CMD" base64 -d -A >"$_st_raw" 2>/dev/null || true
  if ! ed25519_verify_file "$_st_canon" "$_st_raw"; then
    rm -f "$_st_canon" "$_st_raw"
    printf 'selftest: signature INVALID\n' >&2
    exit 1
  fi
  rm -f "$_st_canon" "$_st_raw"
  if [ -n "${TOMAT_SELFTEST_ARTIFACT:-}" ]; then
    _st_sha="sha256sum"
    command -v sha256sum >/dev/null 2>&1 || _st_sha="shasum -a 256"
    _st_got="$($_st_sha "$TOMAT_SELFTEST_ARTIFACT" 2>/dev/null | awk '{print $1}')"
    if [ "$_st_got" != "$TOMAT_SELFTEST_SHA" ]; then
      printf 'selftest: sha256 MISMATCH\n' >&2
      exit 1
    fi
  fi
  printf 'selftest: OK\n'
  exit 0
fi

mkdir -p "$BIN_DIR" "$WORKERS_DIR" "$EXTENSIONS_DIR" "$STAGING_DIR" "$LOGS_DIR"

# jq is needed from the manifest step onward; provision a pinned static build now
# if the host has none, so the rest of the install can assume `jq` on PATH.
ensure_jq

# Service registration (launchd / systemd-user / Scheduled Task, or the nohup
# fallback) is chosen and performed by the core binary's install-service
# subcommand, so this script no longer probes for systemd or builds a label.
# The admin password is likewise no longer prompted here: the client sets it
# over the API after pairing, and headless installs can set it later.

# --- begin UI -------------------------------------------------------------

ui_init "tomat Core installer"

# Register every row up front so the cursor knows the total height. The seed
# binary is fetched + verified here; everything past it is delegated to the
# core binary's install subcommands.
#
# Row labels are user-facing copy in two places at once: this terminal AND the
# Client's install button, which tails the non-TTY transcript and shows the
# active row's label with a running percentage (tomat-client
# .../commands/pairing.rs). Keep them short, plain, and free of paths/URLs;
# put specifics in the suffix or the stderr progress lines instead.
IDX_HOST=$(ui_action_add "Checking this computer")
IDX_MANIFEST=$(ui_action_add "Finding the newest Core")
IDX_BIN=$(ui_action_add "Downloading the Core")
IDX_DEPS=$(ui_action_add "Installing helpers and workers")
IDX_SERVICE=$(ui_action_add "Starting the Core")
IDX_PAIR=$(ui_action_add "Getting a pairing code")

# --- action 1: detect host -----------------------------------------------

ui_action_start "$IDX_HOST" "Checking this computer"

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

ui_action_start "$IDX_MANIFEST" "Finding the newest Core"

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
SIG_CANON="$STAGING_DIR/tomat-canon-$$.bin"
SIG_RAW="$STAGING_DIR/tomat-sig-$$.bin"
printf '%s' "$MANIFEST_JSON" | jq -Sjc 'del(.signature)' >"$SIG_CANON" 2>/dev/null
printf '%s' "$MANIFEST_JSON" | jq -r '.signature // empty' | "$OPENSSL_CMD" base64 -d -A >"$SIG_RAW" 2>/dev/null
if ! ed25519_verify_file "$SIG_CANON" "$SIG_RAW"; then
  rm -f "$SIG_CANON" "$SIG_RAW"
  ui_die "Manifest signature verification failed" \
    "" \
    "the manifest may have been tampered with in transit; aborting"
fi
rm -f "$SIG_CANON" "$SIG_RAW"

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
  ui_action_start "$IDX_BIN" "Downloading the Core" "(downloading)"

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

# --- deps + service + pairing (delegated to the core binary) --------------
#
# Everything past the seed binary is the core binary's own responsibility now
# (packages/tomat-core/src/install), so this script stays thin and there is ONE
# audited implementation of dependency fetch, service registration, secret
# bootstrap, extension seeding, and pairing:
#   self-install     fetch + verify the workers + helpers from the signed manifest
#   install-service  write the admin token, optionally seed bind-all, plant the
#                    built-in extension, then register + start the OS service
#   mint-code        print the first pairing code as JSON
# TOMAT_CHANNEL / TOMAT_INSTALL_SERVICE / TOMAT_INSTALL_BIND_ALL /
# TOMAT_INSTALL_BEHIND_PROXY flow through the environment set at the top of
# this script.

ui_action_start "$IDX_DEPS" "Installing helpers and workers"
if ! TOMAT_CHANNEL="$TOMAT_CHANNEL" "$INSTALLED_BIN" self-install >&2; then
  ui_die "Failed to install helpers and workers" \
    "" \
    "re-run; verification output is above"
fi
ui_action_done "$IDX_DEPS"

ui_action_start "$IDX_SERVICE" "Starting the Core"
if ! TOMAT_CHANNEL="$TOMAT_CHANNEL" \
     TOMAT_INSTALL_SERVICE="$INSTALL_SERVICE" \
     TOMAT_INSTALL_BIND_ALL="$INSTALL_BIND_ALL" \
     TOMAT_INSTALL_BEHIND_PROXY="$INSTALL_BEHIND_PROXY" \
     "$INSTALLED_BIN" install-service >&2; then
  ui_die "Failed to start the Core" \
    "" \
    "re-run with TOMAT_INSTALL_SERVICE=0 to launch core without a service"
fi
ui_action_done "$IDX_SERVICE"

# --- mint the first pairing code -----------------------------------------

ui_action_start "$IDX_PAIR" "Getting a pairing code" "(waiting for core)"
CODE=""
PAIR_JSON="$(TOMAT_CHANNEL="$TOMAT_CHANNEL" "$INSTALLED_BIN" mint-code 2>/dev/null || true)"
if [ -n "$PAIR_JSON" ]; then
  CODE="$(printf '%s' "$PAIR_JSON" | jq -r '.code // empty' 2>/dev/null || true)"
fi
if [ -n "$CODE" ]; then
  ui_action_done "$IDX_PAIR"
else
  ui_action_skip "$IDX_PAIR" "(could not mint; see manual instructions below)"
fi

# --- footer ---------------------------------------------------------------

# The "Pairing code:" line is parsed by the client's install trampoline
# (tomat-client .../commands/pairing.rs parse_pairing_code); keep the prefix.
if [ -n "$CODE" ]; then
  ui_finish \
    "Pairing code: $CODE" \
    "" \
    "Open a tomat Client, choose to pair with a Core on another computer," \
    "and enter:" \
    "  URL : https://127.0.0.1:$CORE_PORT   (or this host's LAN IP)" \
    "  Code: $CODE"
else
  ui_finish \
    "The Core is installed. Get a pairing code with:" \
    "  \"$INSTALLED_BIN\" mint-code"
fi

exit 0
