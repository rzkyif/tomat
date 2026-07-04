#!/usr/bin/env bash
# tomat-client uninstaller for macOS / Linux.
#
# Removes the platform-native install:
#   - macOS: deletes /Applications/tomat.app (case-insensitive -- finds the
#            actual bundle regardless of whether it shipped lowercase or
#            capitalized).
#   - Linux: deletes ~/.local/bin/tomat-client.AppImage and its .desktop
#            entry, then refreshes the desktop database when available.
#
# The paired-core list and its keychain tokens are ALWAYS removed, so a
# re-install starts clean and does not try to reach a Core that is gone. The
# rest of the Client's data under ~/.tomat/<channel>/client/ (settings and
# snippets) is removed too by default; pass --keep-data to preserve just that.
#
# Usage:
#   curl -fsSL https://get.au.tomat.ing/install/client-uninstall.sh | bash
#   curl -fsSL https://get.au.tomat.ing/install/client-uninstall.sh | bash -s -- --keep-data
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

KEEP_DATA=0
# Channel selectable via TOMAT_CHANNEL env or --channel <c> / --latest (arg wins).
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-data) KEEP_DATA=1; shift ;;
    --channel) TOMAT_CHANNEL="${2:-}"; shift 2 ;;
    --channel=*) TOMAT_CHANNEL="${1#*=}"; shift ;;
    --latest) TOMAT_CHANNEL="latest"; shift ;;
    --stable) TOMAT_CHANNEL="stable"; shift ;;
    *) printf 'warn: unknown arg: %s\n' "$1" >&2; shift ;;
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
  DISPLAY_NAME="tomat"
else
  CHANNEL_SUFFIX="-$TOMAT_CHANNEL"
  case "$TOMAT_CHANNEL" in
    latest) DISPLAY_NAME="tomat (latest)" ;;
    dev) DISPLAY_NAME="tomat (dev)" ;;
  esac
fi
# The macOS bundle installs under the friendly DISPLAY_NAME (e.g.
# "tomat (latest).app"); CHANNEL_SUFFIX (dash form) still names the keychain
# service + the Linux AppImage, which are not the user-facing app icon.
APP_DEST="/Applications/$DISPLAY_NAME.app"
APPIMAGE_NAME="tomat-client$CHANNEL_SUFFIX"

uname_os="$(uname -s 2>/dev/null || echo unknown)"

case "$uname_os" in
  Darwin)
    LABEL_REMOVE="Removing $APP_DEST"
    ;;
  Linux)
    LABEL_REMOVE="Removing AppImage and .desktop entry under ~/.local/"
    ;;
  *)
    printf 'error: unsupported OS: %s\n' "$uname_os" >&2
    exit 1
    ;;
esac

CLIENT_DATA_DIR="$HOME/.tomat/$TOMAT_CHANNEL/client"
CORES_JSON="$CLIENT_DATA_DIR/cores.json"
# The dev/android channels back paired-core tokens with this file inside the data
# dir instead of the OS keychain; it is part of the paired-core state, so it goes
# with cores.json even under --keep-data.
KEYCHAIN_JSON="$CLIENT_DATA_DIR/keychain.json"
# On signed desktop builds the Client stores each paired core's bearer token in
# the OS keychain under this service / account "core:<coreId>" (mirrors the
# client's channel.rs + keychain.rs). Always cleared, since the paired-core list
# is always removed; --keep-data preserves only the settings.
KEYCHAIN_SERVICE="tomat-client$CHANNEL_SUFFIX"

# --- begin UI -------------------------------------------------------------

ui_init "tomat-client uninstaller"

IDX_REMOVE_APP=$(ui_action_add "$LABEL_REMOVE")
# Paired cores (tokens + list) are always removed; settings only when not kept.
IDX_KEYCHAIN=$(ui_action_add "Clearing paired-core tokens")
if [ "$KEEP_DATA" = "1" ]; then
  IDX_CORES=$(ui_action_add "Removing paired-core list (keeping settings)")
  IDX_DATA=-1
else
  IDX_CORES=-1
  IDX_DATA=$(ui_action_add "Removing $CLIENT_DATA_DIR")
fi

# --- action 1: remove the app --------------------------------------------

if [ "$uname_os" = "Darwin" ]; then
  # Case-insensitive lookup of this channel's bundle by its friendly install
  # name (tomat.app / "tomat (latest).app"), matching client.sh's APP_DEST.
  # -iname also matches an older capitalized form.
  FOUND_APP="$(find /Applications -maxdepth 1 -iname "$DISPLAY_NAME.app" -print -quit 2>/dev/null || true)"

  if [ -z "$FOUND_APP" ]; then
    ui_action_skip "$IDX_REMOVE_APP" "(not installed)"
  else
    ui_action_start "$IDX_REMOVE_APP" "$LABEL_REMOVE"
    if ! rm -rf "$FOUND_APP" 2>/dev/null; then
      ui_die "Permission denied removing $FOUND_APP" \
        "" \
        "the app may be owned by another user; try sudo"
    fi
    ui_action_done "$IDX_REMOVE_APP" "(removed $FOUND_APP)"
  fi
else
  # Linux: remove the AppImage, .desktop, and icon. Refresh the desktop
  # database when the tool is on PATH (folded into this same row).
  APPIMAGE="$HOME/.local/bin/$APPIMAGE_NAME.AppImage"
  DESKTOP="$HOME/.local/share/applications/$APPIMAGE_NAME.desktop"
  ICON="$HOME/.local/share/icons/hicolor/256x256/apps/$APPIMAGE_NAME.png"

  if [ ! -f "$APPIMAGE" ] && [ ! -f "$DESKTOP" ] && [ ! -f "$ICON" ]; then
    ui_action_skip "$IDX_REMOVE_APP" "(not installed)"
  else
    ui_action_start "$IDX_REMOVE_APP" "$LABEL_REMOVE"
    for f in "$APPIMAGE" "$DESKTOP" "$ICON"; do
      if [ -f "$f" ]; then
        if ! rm -f "$f" 2>/dev/null; then
          ui_die "Permission denied removing $f" \
            "" \
            "check ownership of ~/.local"
        fi
      fi
    done
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    ui_action_done "$IDX_REMOVE_APP" "(removed)"
  fi
fi

# --- action 2: clear paired-core tokens ----------------------------------
# Always runs (the paired-core list is always removed). Reads cores.json before
# it is deleted below. Per platform + channel (mirrors the Client's keychain.rs):
#   - macOS stable/latest: OS keychain, cleared per core id via the `security` CLI.
#   - Linux stable/latest: the DBus Secret Service, whose items this Client tags
#     with attribute service="$KEYCHAIN_SERVICE"; `secret-tool clear service ...`
#     drops every one of ours in a single call.
#   - dev/android: a keychain.json file inside the data dir, removed below.
# Where we cannot reach the store (no tool, no running keychain), we leave the
# tokens and note the residue rather than claiming success.

KEYCHAIN_RESIDUE=0
if [ "$uname_os" = "Darwin" ]; then
  if ! command -v security >/dev/null 2>&1; then
    ui_action_skip "$IDX_KEYCHAIN" "(security tool not found)"
    KEYCHAIN_RESIDUE=1
  elif [ ! -f "$CORES_JSON" ]; then
    ui_action_skip "$IDX_KEYCHAIN" "(no tokens)"
  else
    ui_action_start "$IDX_KEYCHAIN" "Clearing paired-core tokens"
    if command -v jq >/dev/null 2>&1; then
      CORE_IDS="$(jq -r '.cores[]?.id // empty' "$CORES_JSON" 2>/dev/null || true)"
    else
      # Grep fallback: pull every "id": "<value>" (only core entries carry an
      # `id` key; the current pointer is `currentCoreId`), works minified too.
      CORE_IDS="$(grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]+"' "$CORES_JSON" 2>/dev/null \
        | grep -oE '"[^"]+"$' | tr -d '"' || true)"
    fi
    CLEARED=0
    for id in $CORE_IDS; do
      if security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "core:$id" >/dev/null 2>&1; then
        CLEARED=$((CLEARED + 1))
      fi
    done
    if [ "$CLEARED" = "0" ]; then
      ui_action_skip "$IDX_KEYCHAIN" "(no tokens)"
    else
      ui_action_done "$IDX_KEYCHAIN" "(cleared $CLEARED)"
    fi
  fi
elif [ "$uname_os" = "Linux" ]; then
  if [ ! -f "$CORES_JSON" ]; then
    # No paired cores means none of our Secret Service tokens to clear (parity
    # with the macOS branch, which keys off cores.json the same way).
    ui_action_skip "$IDX_KEYCHAIN" "(no tokens)"
  elif ! command -v secret-tool >/dev/null 2>&1; then
    # dev-channel tokens live in keychain.json (removed below), so this only
    # leaves stable/latest Secret Service tokens behind.
    ui_action_skip "$IDX_KEYCHAIN" "(secret-tool not found; tokens may remain)"
    KEYCHAIN_RESIDUE=1
  else
    ui_action_start "$IDX_KEYCHAIN" "Clearing paired-core tokens"
    if secret-tool clear service "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
      ui_action_done "$IDX_KEYCHAIN" "(cleared)"
    else
      # No running Secret Service (e.g. a headless / SSH session with no D-Bus).
      ui_action_skip "$IDX_KEYCHAIN" "(no keychain running; tokens may remain)"
      KEYCHAIN_RESIDUE=1
    fi
  fi
else
  ui_action_skip "$IDX_KEYCHAIN" "(tokens may remain in keychain)"
  KEYCHAIN_RESIDUE=1
fi

# --- action 3: remove client data ----------------------------------------
# --keep-data drops only the paired-core state (cores.json + the dev/android
# keychain.json), leaving settings and snippets; otherwise the whole dir goes.

if [ "$IDX_CORES" != "-1" ]; then
  if [ ! -f "$CORES_JSON" ] && [ ! -f "$KEYCHAIN_JSON" ]; then
    ui_action_skip "$IDX_CORES" "(no paired cores)"
  else
    ui_action_start "$IDX_CORES" "Removing paired-core list (keeping settings)"
    if ! rm -f "$CORES_JSON" "$KEYCHAIN_JSON" 2>/dev/null; then
      ui_die "Permission denied removing paired-core files in $CLIENT_DATA_DIR" \
        "" \
        "quit tomat and re-run"
    fi
    ui_action_done "$IDX_CORES" "(removed)"
  fi
fi

if [ "$IDX_DATA" != "-1" ]; then
  if [ ! -d "$CLIENT_DATA_DIR" ]; then
    ui_action_skip "$IDX_DATA" "(no data found)"
  else
    ui_action_start "$IDX_DATA" "Removing $CLIENT_DATA_DIR"
    if ! rm -rf "$CLIENT_DATA_DIR" 2>/dev/null; then
      ui_die "Permission denied removing $CLIENT_DATA_DIR" \
        "" \
        "quit tomat and re-run"
    fi
    # Best-effort: drop the now-empty channel dir (~/.tomat/<channel>) once both
    # client and core data are gone. rmdir only succeeds when empty, so a core
    # still installed on this channel keeps it (the shared models dir lives under
    # ~/.tomat, not the channel dir, so it is never affected).
    rmdir "$HOME/.tomat/$TOMAT_CHANNEL" 2>/dev/null || true
    ui_action_done "$IDX_DATA" "(removed)"
  fi
fi

# --- footer ---------------------------------------------------------------

# The keychain-residue note only applies when action 2 could not reach the store
# (no tool, or no running keychain). The paired-core list itself is always gone.
KEYCHAIN_NOTE=""
if [ "$KEYCHAIN_RESIDUE" = "1" ]; then
  KEYCHAIN_NOTE="A few paired-core tokens may remain in your OS keychain; remove them manually if desired."
fi

if [ "$KEEP_DATA" = "1" ]; then
  SETTINGS_NOTE="Settings in $CLIENT_DATA_DIR were kept (per --keep-data); the paired-core list was removed."
  if [ -n "$KEYCHAIN_NOTE" ]; then
    ui_finish "tomat-client uninstalled." "" "$SETTINGS_NOTE" "$KEYCHAIN_NOTE"
  else
    ui_finish "tomat-client uninstalled." "" "$SETTINGS_NOTE"
  fi
elif [ -n "$KEYCHAIN_NOTE" ]; then
  ui_finish "tomat-client uninstalled." "" "$KEYCHAIN_NOTE"
else
  ui_finish "tomat-client uninstalled."
fi

exit 0
