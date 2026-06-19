#!/usr/bin/env bash
# tomat-client installer for macOS / Linux.
#
# Fetches client.json from the storage origin, picks the matching artifact
# for this host triple, downloads it, and installs:
#   - macOS: downloads the .app.tar.gz, extracts the bundle straight into
#            /Applications/, and clears any com.apple.quarantine xattr so
#            Gatekeeper doesn't pop the "developer cannot be verified" sheet
#            on first launch.
#   - Linux: drops the AppImage into ~/.local/bin/, chmod +x it, registers a
#            .desktop entry so it shows up in launchers.
#
# Usage:
#   curl -fsSL https://get.au.tomat.ing/install/client.sh | bash
#
# Env overrides:
#   TOMAT_STORAGE  override storage base URL (default: https://get.au.tomat.ing)
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
  UI_STAGING_PATHS="$UI_STAGING_PATHS $1"
}

_ui_cleanup_staging() {
  local p
  for p in $UI_STAGING_PATHS; do
    [ -e "$p" ] && rm -f "$p" 2>/dev/null || true
  done
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

# Install channel: selectable via TOMAT_CHANNEL env or --channel <c> / --latest
# (the arg wins). A latest client is a distinct app (tomat-latest.app, identifier
# au.tomat.ing.latest) that coexists with stable and updates from the latest
# manifest. Stable stays bare for back-compat.
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
if [ "$TOMAT_CHANNEL" = "stable" ]; then
  CHANNEL_SUFFIX=""
  MANIFEST_DIR="manifests"
  DISPLAY_NAME="tomat"
else
  CHANNEL_SUFFIX="-$TOMAT_CHANNEL"
  MANIFEST_DIR="manifests/$TOMAT_CHANNEL"
  case "$TOMAT_CHANNEL" in
    latest) DISPLAY_NAME="tomat latest" ;;
    dev) DISPLAY_NAME="tomat dev" ;;
  esac
fi
MANIFEST_URL="$STORAGE/$MANIFEST_DIR/client.json"
# Channel-namespaced install targets (match build-client.ts productName).
APP_DEST="/Applications/tomat$CHANNEL_SUFFIX.app"        # macOS
APPIMAGE_NAME="tomat-client$CHANNEL_SUFFIX"              # linux

# --- prerequisites (pre-UI; if these fail we can't even draw the UI) ------

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'error: missing required command: %s\n' "$cmd" >&2
    printf 'hint:  install %s and re-run the installer\n' "$cmd" >&2
    exit 1
  fi
done

# Committed Ed25519 signing public key (base64 raw key), kept in sync with
# packages/tomat-core/data/signing-keys.json (a test guards the match). Used to
# verify the manifest's detached signature before trusting any download URL/hash.
TOMAT_SIGNING_PUBKEY_B64="KghrHOIqu76Hpl/xX8RHUuDA2n1NGCOj9gD1Jrn5H+M="

# Resolve an OpenSSL with Ed25519 raw-verify support (`pkeyutl -rawin`, added in
# OpenSSL 3.0). macOS ships LibreSSL, which lacks it; Homebrew's openssl@3 has
# it. Required: without signature verification a MITM of the storage origin
# could serve an attacker-chosen bundle + matching hash.
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

# --- helper: pick action 3 / 4 labels based on host ----------------------

uname_os="$(uname -s 2>/dev/null || echo unknown)"

if [ "$uname_os" = "Darwin" ]; then
  LABEL_INSTALL="Installing $DISPLAY_NAME to $APP_DEST"
  LABEL_FINALIZE="Clearing Gatekeeper quarantine xattr"
else
  LABEL_INSTALL="Installing AppImage to ~/.local/bin/$APPIMAGE_NAME.AppImage"
  LABEL_FINALIZE="Registering .desktop entry at ~/.local/share/applications/$APPIMAGE_NAME.desktop"
fi

# --- staging dir ----------------------------------------------------------

STAGING_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t tomat-client-staging)"
# Track the whole dir for cleanup. _ui_cleanup_staging uses rm -f which
# won't recurse, so we register child files individually as we create them.

# --- begin UI -------------------------------------------------------------

ui_init "tomat-client installer"

IDX_HOST=$(ui_action_add "Detecting host")
IDX_MANIFEST=$(ui_action_add "Fetching manifest from get.au.tomat.ing")
IDX_INSTALL=$(ui_action_add "$LABEL_INSTALL")
IDX_FINALIZE=$(ui_action_add "$LABEL_FINALIZE")

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

MANIFEST_TMP="$STAGING_DIR/client-manifest-$$.json"
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
      if [ "$MANIFEST_HTTP_STATUS" = "404" ] || [ -z "$MANIFEST_HTTP_STATUS" ]; then
        ui_die "Manifest not found at $MANIFEST_URL" \
          "HTTP 404" \
          "the storage origin may be misconfigured; report at github.com/<repo>/issues"
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

# Authenticate the manifest before trusting any URL/sha256 in it. client.json is
# the Tauri updater endpoint, so its tomat signature is a detached sidecar
# (client.json.sig = base64 Ed25519 over the exact client.json bytes) rather than
# an embedded field. Verify the bytes as downloaded. Fail closed.
SIG_URL="$STORAGE/$MANIFEST_DIR/client.json.sig"
SIG_B64_TMP="$STAGING_DIR/client-manifest-sig-$$.b64"
_ui_track_staging "$SIG_B64_TMP"
if ! curl -fsSL -o "$SIG_B64_TMP" "$SIG_URL" 2>/dev/null || [ ! -s "$SIG_B64_TMP" ]; then
  rm -f "$SIG_B64_TMP"
  ui_die "Could not fetch manifest signature" \
    "$SIG_URL" \
    "the storage origin may be misconfigured"
fi
SIG_PEM="$STAGING_DIR/tomat-pubkey-$$.pem"
SIG_RAW="$STAGING_DIR/tomat-sig-$$.bin"
printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' \
  "$TOMAT_SIGNING_PUBKEY_B64" >"$SIG_PEM"
"$OPENSSL_CMD" base64 -d -A <"$SIG_B64_TMP" >"$SIG_RAW" 2>/dev/null
if ! "$OPENSSL_CMD" pkeyutl -verify -pubin -inkey "$SIG_PEM" -rawin -in "$MANIFEST_TMP" -sigfile "$SIG_RAW" >/dev/null 2>&1; then
  rm -f "$SIG_PEM" "$SIG_RAW" "$SIG_B64_TMP"
  ui_die "Manifest signature verification failed" \
    "" \
    "the manifest may have been tampered with in transit; aborting"
fi
rm -f "$SIG_PEM" "$SIG_RAW" "$SIG_B64_TMP"

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

URL="$(printf '%s' "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.platforms[$t].url // empty' 2>/dev/null || true)"
if [ -z "$URL" ]; then
  ui_die "No client artifact for $TRIPLE in manifest" \
    "" \
    "your platform may not be supported yet"
fi
# Per-platform sha256: the integrity anchor for the downloaded bundle. The
# bundle ships over TLS, but verifying this hash before install is what stops a
# tampered/MITM'd artifact from being installed (and, on macOS, having Gatekeeper
# stripped). The release script always publishes it; a missing hash means a
# too-old or tampered manifest, so we fail closed at verification time.
EXPECTED_SHA="$(printf '%s' "$MANIFEST_JSON" | jq -r --arg t "$TRIPLE" '.platforms[$t].sha256 // empty' 2>/dev/null || true)"

# Resolve the sha-256 command once (sha256sum or shasum -a 256).
SHA_CMD="sha256sum"
if ! command -v sha256sum >/dev/null 2>&1; then
  if command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
  else
    SHA_CMD=""
  fi
fi

# Verify a freshly-downloaded artifact against the manifest sha256 BEFORE it is
# installed. Fails closed if the manifest carries no hash or no sha tool exists.
verify_sha256() {
  _vfile="$1"
  _vlabel="$2"
  if [ -z "$EXPECTED_SHA" ]; then
    ui_die "Manifest is missing an integrity hash for the $_vlabel" \
      "no .platforms[$TRIPLE].sha256 in client.json" \
      "the release is too old or has been tampered with; do not install"
  fi
  if [ -z "$SHA_CMD" ]; then
    ui_die "Cannot verify the $_vlabel: no sha256 tool" \
      "sha256sum or shasum is required" \
      "install coreutils or perl (shasum) and re-run"
  fi
  _vgot="$($SHA_CMD "$_vfile" 2>/dev/null | awk '{print $1}')"
  if [ "$_vgot" != "$EXPECTED_SHA" ]; then
    ui_die "sha256 mismatch on the $_vlabel" \
      "want $EXPECTED_SHA, got $_vgot" \
      "network corruption or tampering; do not install, re-run"
  fi
}

ui_action_done "$IDX_MANIFEST" "(v$VERSION)"

# --- action 3: install app -----------------------------------------------

if [ "$uname_os" = "Darwin" ]; then
  # Pre-check: existing app at the channel's path with matching CFBundleVersion.
  EXISTING_OK=0
  if [ -d "$APP_DEST" ]; then
    EXISTING_VER="$(defaults read "$APP_DEST/Contents/Info" CFBundleVersion 2>/dev/null || true)"
    if [ "$EXISTING_VER" = "$VERSION" ]; then
      EXISTING_OK=1
    fi
  fi

  if [ "$EXISTING_OK" = "1" ]; then
    ui_action_skip "$IDX_INSTALL" "(already current)"
  else
    ui_action_start "$IDX_INSTALL" "$LABEL_INSTALL" "(downloading)"

    TARBALL="$STAGING_DIR/tomat-client-$VERSION-$$.app.tar.gz"
    _ui_track_staging "$TARBALL"

    DL_CURL_RC=0
    curl -fsSL -o "$TARBALL" "$URL" 2>/dev/null || DL_CURL_RC=$?
    if [ "$DL_CURL_RC" -ne 0 ]; then
      case "$DL_CURL_RC" in
        6|7)
          ui_die "Network error reaching get.au.tomat.ing" \
            "curl exit $DL_CURL_RC fetching $URL" \
            "check internet connectivity, then re-run"
          ;;
        *)
          ui_die "Download interrupted" \
            "curl exit $DL_CURL_RC fetching $URL" \
            "re-run; partial files were cleaned up"
          ;;
      esac
    fi

    ui_action_update "$IDX_INSTALL" "(verifying)"
    verify_sha256 "$TARBALL" "client bundle"

    ui_action_update "$IDX_INSTALL" "(extracting)"
    EXTRACT_DIR="$STAGING_DIR/extracted-$$"
    mkdir -p "$EXTRACT_DIR"
    EXTRACT_ERR="$(tar -xzf "$TARBALL" -C "$EXTRACT_DIR" 2>&1)" || \
      ui_die "Failed to extract client tarball" \
        "$EXTRACT_ERR" \
        "partial download; re-run"

    # Discover the actual app bundle name (the .app basename may be any case,
    # depending on Tauri config). We use the one we find, but the destination
    # path is always /Applications/tomat.app to match the current productName.
    APP_SRC="$(find "$EXTRACT_DIR" -maxdepth 2 -name "*.app" -type d | head -n1)"
    if [ -z "$APP_SRC" ]; then
      ui_die "Client tarball is corrupted" \
        "no .app inside" \
        "redownload and re-run"
    fi

    APP_NAME="$(basename "$APP_SRC")"
    DEST="/Applications/$APP_NAME"

    ui_action_update "$IDX_INSTALL" "(installing)"
    if [ -d "$DEST" ]; then
      if ! rm -rf "$DEST" 2>/dev/null; then
        ui_die "Permission denied removing existing $DEST" \
          "" \
          "quit $DISPLAY_NAME and try again, or check if the app is owned by another user"
      fi
    fi

    CP_ERR="$(cp -R "$APP_SRC" /Applications/ 2>&1)" || {
      # Distinguish disk-full from permission-denied based on stderr.
      case "$CP_ERR" in
        *"No space left"*|*"ENOSPC"*)
          ui_die "No space left in /Applications" \
            "$CP_ERR" \
            "free disk space and re-run"
          ;;
        *)
          ui_die "Permission denied writing to /Applications" \
            "$CP_ERR" \
            "check ownership of /Applications, or try sudo"
          ;;
      esac
    }

    # Clean up the staging tarball + extract dir now that the bundle is in
    # place; the EXIT trap would catch the tarball, but the extract dir is
    # untracked.
    rm -rf "$EXTRACT_DIR" 2>/dev/null || true
    rm -f "$TARBALL" 2>/dev/null || true

    # Pretty file size for the detail.
    APP_BYTES="$(du -sk "$DEST" 2>/dev/null | awk '{print $1 * 1024}')"
    if [ -n "$APP_BYTES" ] && [ "$APP_BYTES" -gt 0 ]; then
      APP_MB="$((APP_BYTES / 1024 / 1024))"
      ui_action_done "$IDX_INSTALL" "(${APP_MB} MB)"
    else
      ui_action_done "$IDX_INSTALL" "(v$VERSION)"
    fi
  fi
else
  # Linux: AppImage.
  BIN_DIR="$HOME/.local/bin"
  APPS_DIR="$HOME/.local/share/applications"
  ICONS_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR"

  APPIMAGE="$BIN_DIR/$APPIMAGE_NAME.AppImage"

  # Pre-check: AppImage already on disk, and (when manifest provides one)
  # the sha matches. If the manifest doesn't carry a sha, we ALWAYS download
  # (no way to know whether the on-disk file is current).
  EXISTING_OK=0
  if [ -f "$APPIMAGE" ] && [ -n "$EXPECTED_SHA" ]; then
    # Resolve sha command lazily -- we only need it on this branch.
    SHA_CMD="sha256sum"
    if ! command -v sha256sum >/dev/null 2>&1; then
      if command -v shasum >/dev/null 2>&1; then
        SHA_CMD="shasum -a 256"
      else
        SHA_CMD=""
      fi
    fi
    if [ -n "$SHA_CMD" ]; then
      EXISTING_SHA="$($SHA_CMD "$APPIMAGE" 2>/dev/null | awk '{print $1}')"
      if [ "$EXISTING_SHA" = "$EXPECTED_SHA" ]; then
        EXISTING_OK=1
      fi
    fi
  fi

  if [ "$EXISTING_OK" = "1" ]; then
    ui_action_skip "$IDX_INSTALL" "(already current)"
  else
    ui_action_start "$IDX_INSTALL" "$LABEL_INSTALL" "(downloading)"

    APPIMAGE_TMP="$STAGING_DIR/tomat-client-$VERSION-$$.AppImage"
    _ui_track_staging "$APPIMAGE_TMP"

    DL_CURL_RC=0
    curl -fsSL -o "$APPIMAGE_TMP" "$URL" 2>/dev/null || DL_CURL_RC=$?
    if [ "$DL_CURL_RC" -ne 0 ]; then
      case "$DL_CURL_RC" in
        6|7)
          ui_die "Network error reaching get.au.tomat.ing" \
            "curl exit $DL_CURL_RC fetching $URL" \
            "check internet connectivity, then re-run"
          ;;
        *)
          ui_die "Download interrupted" \
            "curl exit $DL_CURL_RC fetching $URL" \
            "re-run; partial files were cleaned up"
          ;;
      esac
    fi

    ui_action_update "$IDX_INSTALL" "(verifying)"
    verify_sha256 "$APPIMAGE_TMP" "AppImage"

    ui_action_update "$IDX_INSTALL" "(installing)"
    if ! mv -f "$APPIMAGE_TMP" "$APPIMAGE" 2>/dev/null; then
      ui_die "Permission denied writing to ~/.local/bin" \
        "" \
        "check ownership of ~/.local"
    fi
    if ! chmod +x "$APPIMAGE" 2>/dev/null; then
      ui_die "Failed to make AppImage executable" \
        "" \
        "~/.local/bin may be on a noexec mount"
    fi

    APP_BYTES="$(wc -c < "$APPIMAGE" 2>/dev/null | tr -d ' ' || echo 0)"
    APP_MB="$((APP_BYTES / 1024 / 1024))"
    ui_action_done "$IDX_INSTALL" "(${APP_MB} MB)"
  fi
fi

# --- action 4: finalize (Gatekeeper / .desktop) ---------------------------

if [ "$uname_os" = "Darwin" ]; then
  # Pre-check: is the quarantine xattr already absent?
  QUAR="$(xattr -p com.apple.quarantine "$APP_DEST" 2>/dev/null || true)"
  if [ -z "$QUAR" ]; then
    ui_action_skip "$IDX_FINALIZE" "(no quarantine present)"
  else
    ui_action_start "$IDX_FINALIZE" "$LABEL_FINALIZE"
    if xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null; then
      ui_action_done "$IDX_FINALIZE" "(cleared)"
    else
      # Non-fatal -- the install still works.
      ui_action_done "$IDX_FINALIZE" "(could not clear)"
    fi
  fi
else
  # Linux: write the .desktop entry. Pre-check: file present AND Exec= line
  # matches the AppImage path.
  APPS_DIR="$HOME/.local/share/applications"
  DESKTOP="$APPS_DIR/$APPIMAGE_NAME.desktop"
  APPIMAGE="$HOME/.local/bin/$APPIMAGE_NAME.AppImage"

  DESKTOP_OK=0
  if [ -f "$DESKTOP" ]; then
    if grep -q "^Exec=$APPIMAGE\$" "$DESKTOP" 2>/dev/null; then
      DESKTOP_OK=1
    fi
  fi

  if [ "$DESKTOP_OK" = "1" ]; then
    ui_action_skip "$IDX_FINALIZE" "(already registered)"
  else
    ui_action_start "$IDX_FINALIZE" "$LABEL_FINALIZE"

    mkdir -p "$APPS_DIR"
    if ! cat >"$DESKTOP" <<DESKTOP 2>/dev/null
[Desktop Entry]
Type=Application
Name=$DISPLAY_NAME
Comment=Local-first modular AI client
Exec=$APPIMAGE
Icon=$APPIMAGE_NAME
Terminal=false
Categories=Utility;
DESKTOP
    then
      ui_die "Permission denied writing ~/.local/share/applications/$APPIMAGE_NAME.desktop" \
        "" \
        "check ownership of ~/.local/share"
    fi

    if command -v update-desktop-database >/dev/null 2>&1; then
      if update-desktop-database "$APPS_DIR" 2>/dev/null; then
        ui_action_done "$IDX_FINALIZE" "(registered)"
      else
        ui_action_done "$IDX_FINALIZE" "(.desktop registered, database refresh failed)"
      fi
    else
      ui_action_done "$IDX_FINALIZE" "(.desktop registered, database not refreshed)"
    fi
  fi
fi

# --- footer ---------------------------------------------------------------

if [ "$uname_os" = "Darwin" ]; then
  ui_finish \
    "$DISPLAY_NAME installed → $APP_DEST" \
    "" \
    "Launch from /Applications or via Spotlight."
else
  APPIMAGE="$HOME/.local/bin/$APPIMAGE_NAME.AppImage"
  ui_finish \
    "$DISPLAY_NAME installed → $APPIMAGE" \
    "" \
    "Launch via your application menu or run the AppImage directly."
fi

exit 0
