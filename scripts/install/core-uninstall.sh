#!/usr/bin/env bash
# tomat-core uninstaller for macOS / Linux.
#
# Stops and unregisters the launchd / systemd-user service, kills any
# straggler core processes, then deletes ~/.tomat/<channel>/core/. Models in
# ~/.tomat/models/ are LEFT IN PLACE (shared across channels) because they
# can be huge and the user may want to keep them -- re-running the installer
# will pick them back up.
#
# Usage:
#   curl -fsSL https://get.au.tomat.ing/install/core-uninstall.sh | bash
#   curl -fsSL https://get.au.tomat.ing/install/core-uninstall.sh | bash -s -- --keep-data
#
# Flags:
#   --keep-data  do not remove the channel's core dir (only stop / unregister services).
#
# Env overrides:
#   TOMAT_CHANNEL      channel to uninstall: stable (default) | dev | latest.
#   TOMAT_CORE_HOME    override install root (default: ~/.tomat/<channel>/core)
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
# Per-channel suffix on binary + service names (stable stays bare). Mirrors
# core.sh + paths.ts channelSuffix.
if [ "$TOMAT_CHANNEL" = "stable" ]; then
  CHANNEL_SUFFIX=""
else
  CHANNEL_SUFFIX="-$TOMAT_CHANNEL"
fi
HOME_DIR="${TOMAT_CORE_HOME:-$HOME/.tomat/$TOMAT_CHANNEL/core}"
BIN_DIR="$HOME_DIR/bin"
SERVICE_LABEL_ID="au.tomat.core$CHANNEL_SUFFIX"
SYSTEMD_UNIT="tomat-core$CHANNEL_SUFFIX"
CORE_BIN_NAME="tomat-core$CHANNEL_SUFFIX"
# Core seals its secrets-vault master key in the OS keychain under this
# service/account (mirrors secrets.ts); the helper that manages it is
# channel-suffixed like every core binary (mirrors paths.ts coreBinaryName).
KEYCHAIN_BIN="$BIN_DIR/tomat-core-keychain$CHANNEL_SUFFIX"
KEYCHAIN_SERVICE="au.tomat.core$CHANNEL_SUFFIX"
KEYCHAIN_ACCOUNT="master-key"

uname_os="$(uname -s 2>/dev/null || echo unknown)"

case "$uname_os" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL_ID.plist"
    LABEL_SERVICE="Unloading launchd agent ~/Library/LaunchAgents/$SERVICE_LABEL_ID.plist"
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/$SYSTEMD_UNIT.service"
    LABEL_SERVICE="Disabling systemd user unit ~/.config/systemd/user/$SYSTEMD_UNIT.service"
    ;;
  *)
    printf 'error: unsupported OS: %s\n' "$uname_os" >&2
    exit 1
    ;;
esac

# --- begin UI -------------------------------------------------------------

ui_init "tomat-core uninstaller"

IDX_SERVICE=$(ui_action_add "$LABEL_SERVICE")
IDX_KILL=$(ui_action_add "Killing straggler tomat-core processes")
IDX_KEYCHAIN=$(ui_action_add "Clearing keychain entry")
IDX_REMOVE=$(ui_action_add "Removing $HOME_DIR")

# --- action 1: unload service --------------------------------------------

if [ "$uname_os" = "Darwin" ]; then
  if [ ! -f "$PLIST" ]; then
    ui_action_skip "$IDX_SERVICE" "(not installed)"
  else
    ui_action_start "$IDX_SERVICE" "$LABEL_SERVICE"
    # `launchctl unload` often returns non-zero for benign reasons (the
    # agent already exited, etc.); the meaningful step is removing the
    # plist so launchd never auto-loads it again on next login.
    launchctl unload "$PLIST" 2>/dev/null || true
    if rm -f "$PLIST" 2>/dev/null; then
      ui_action_done "$IDX_SERVICE" "(unloaded)"
    else
      # Both unload and rm effectively failed -- registration may persist.
      ui_action_error "$IDX_SERVICE" "(could not remove plist)"
    fi
  fi
else
  # Linux
  if [ ! -f "$UNIT" ]; then
    ui_action_skip "$IDX_SERVICE" "(not installed)"
  else
    ui_action_start "$IDX_SERVICE" "$LABEL_SERVICE"
    systemctl --user disable --now "$SYSTEMD_UNIT.service" 2>/dev/null || true
    if rm -f "$UNIT" 2>/dev/null; then
      systemctl --user daemon-reload 2>/dev/null || true
      ui_action_done "$IDX_SERVICE" "(disabled)"
    else
      ui_action_error "$IDX_SERVICE" "(could not remove unit)"
    fi
  fi
fi

# --- action 2: kill stragglers -------------------------------------------

PIDS=""
if command -v pgrep >/dev/null 2>&1; then
  PIDS="$(pgrep -f "$HOME_DIR/bin/$CORE_BIN_NAME" 2>/dev/null || true)"
fi

if [ -z "$PIDS" ]; then
  ui_action_skip "$IDX_KILL" "(none found)"
else
  ui_action_start "$IDX_KILL" "Killing straggler tomat-core processes"
  # Try SIGTERM first; SIGKILL after a short grace.
  KILLED_COUNT=0
  for pid in $PIDS; do
    if kill "$pid" 2>/dev/null; then
      KILLED_COUNT=$((KILLED_COUNT + 1))
    fi
  done
  sleep 1
  for pid in $PIDS; do
    kill -9 "$pid" 2>/dev/null || true
  done
  ui_action_done "$IDX_KILL" "(killed $KILLED_COUNT)"
fi

# --- action 3: clear the keychain master key -----------------------------
# Done before the dir is removed (the helper lives in $BIN_DIR). Skipped under
# --keep-data so the kept vault stays decryptable. Delete is idempotent, so
# this is a no-op on dev (file fallback, no keychain entry) and on re-runs.

if [ "$KEEP_DATA" = "1" ]; then
  ui_action_skip "$IDX_KEYCHAIN" "(kept with data)"
elif [ -x "$KEYCHAIN_BIN" ]; then
  ui_action_start "$IDX_KEYCHAIN" "Clearing keychain entry"
  # delete is idempotent (exit 0 even if absent), so a non-zero exit is a real
  # failure (keychain locked / unavailable) worth reporting rather than masking.
  if "$KEYCHAIN_BIN" delete "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
    ui_action_done "$IDX_KEYCHAIN" "(cleared)"
  else
    ui_action_skip "$IDX_KEYCHAIN" "(could not clear)"
  fi
elif [ "$uname_os" = "Darwin" ] && command -v security >/dev/null 2>&1; then
  # Helper already gone (e.g. a partially-removed install): fall back to the
  # native macOS keychain tool, which speaks the same generic-password store.
  ui_action_start "$IDX_KEYCHAIN" "Clearing keychain entry"
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 || true
  ui_action_done "$IDX_KEYCHAIN" "(cleared)"
else
  ui_action_skip "$IDX_KEYCHAIN" "(helper not present)"
fi

# --- action 4: remove the channel's core dir -----------------------------

if [ "$KEEP_DATA" = "1" ]; then
  ui_action_skip "$IDX_REMOVE" "(skipped per --keep-data)"
elif [ ! -d "$HOME_DIR" ]; then
  ui_action_skip "$IDX_REMOVE" "(directory not found)"
else
  ui_action_start "$IDX_REMOVE" "Removing $HOME_DIR"
  RM_ERR="$(rm -rf "$HOME_DIR" 2>&1)" || \
    ui_die "Failed to remove $HOME_DIR" \
      "$RM_ERR" \
      "a process may still be holding the directory open; re-run after closing tomat"
  # Best-effort: drop the now-empty channel dir (~/.tomat/<channel>) left behind
  # once both core and client data are gone. rmdir only succeeds when empty, so a
  # client still installed on this channel keeps it (the shared models dir lives
  # under ~/.tomat, not the channel dir, so it is never affected).
  rmdir "$(dirname "$HOME_DIR")" 2>/dev/null || true
  ui_action_done "$IDX_REMOVE" "(removed)"
fi

# --- footer ---------------------------------------------------------------

if [ "$KEEP_DATA" = "1" ]; then
  ui_finish \
    "tomat-core uninstalled." \
    "" \
    "$HOME_DIR kept per --keep-data." \
    "" \
    "Models in ~/.tomat/models/ were left in place; remove manually if desired."
else
  ui_finish \
    "tomat-core uninstalled." \
    "" \
    "Models in ~/.tomat/models/ were left in place; remove manually if desired."
fi

exit 0
