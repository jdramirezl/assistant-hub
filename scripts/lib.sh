#!/usr/bin/env bash
# Shared helpers for setup-mac.sh and deploy.sh. Source, don't execute.
# shellcheck shell=bash
# Variables defined here are used by the scripts that source this file.
# shellcheck disable=SC2034

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HUB_LABEL="com.jdrami.assistant-hub"
BACKUP_LABEL="com.jdrami.assistant-hub.backup"
PLIST_DIR="${PLIST_DIR:-$HOME/Library/LaunchAgents}"
DATA_DIR="${HUB_DATA_DIR:-$HOME/Library/Application Support/assistant-hub}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/assistant-hub}"
HEALTH_URL="http://127.0.0.1:4111/health"
DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
GUI_DOMAIN="gui/$(id -u)"
# launchd retries (tests shorten them)
LAUNCHCTL_TRIES="${LAUNCHCTL_TRIES:-5}"
LAUNCHCTL_SLEEP="${LAUNCHCTL_SLEEP:-2}"
HEALTH_WAIT_S="${HEALTH_WAIT_S:-60}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Run a command, or just print it with --dry-run.
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    { printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; } >&2
  else
    "$@"
  fi
}

confirm() {
  [[ "$ASSUME_YES" == 1 ]] && return 0
  [[ "$DRY_RUN" == 1 ]] && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "this script only supports macOS"
}

macos_version() { sw_vers -productVersion; }

# 0 when macOS version >= $1 (e.g. 26.4)
macos_at_least() {
  local want="$1" have
  have="$(macos_version)"
  [[ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -1)" == "$want" ]]
}

brew_prefix() {
  command -v brew >/dev/null 2>&1 || die "Homebrew is required: https://brew.sh"
  brew --prefix
}

# shellcheck source=scripts/node.sh
source "$REPO/scripts/node.sh"

# Use the same Node launchd will run (see scripts/node.sh) for npm/build in this script.
use_node() {
  local node
  node="$(find_node)" || { [[ "$DRY_RUN" == 1 ]] && return 0; die "no usable Node (run scripts/setup-mac.sh)"; }
  PATH="$(dirname "$node"):$PATH"
  export PATH
  export NODE_BIN="$node"
}

agent_loaded() { launchctl print "$GUI_DOMAIN/$1" >/dev/null 2>&1; }

# bootout is asynchronous: wait until launchd has really dropped the label (else the next
# bootstrap fails with "5: Input/output error" and the service stays unregistered).
unload_agent() {
  local label="$1" i
  agent_loaded "$label" || return 0
  launchctl bootout "$GUI_DOMAIN/$label" >&2 || true
  for ((i = 0; i < LAUNCHCTL_TRIES * 5; i++)); do
    agent_loaded "$label" || return 0
    sleep 0.2
  done
  warn "$label still registered after bootout"
}

# Bootstrap with retry, and only report success once `launchctl print` shows the label.
bootstrap_agent() {
  local label="$1" target="$2" i out
  for ((i = 1; i <= LAUNCHCTL_TRIES; i++)); do
    out="$(launchctl bootstrap "$GUI_DOMAIN" "$target" 2>&1)" || true
    if agent_loaded "$label"; then
      launchctl enable "$GUI_DOMAIN/$label" >&2 || true
      [[ $i -gt 1 ]] && say "$label registered (attempt $i)" >&2
      return 0
    fi
    warn "bootstrap $label attempt $i/$LAUNCHCTL_TRIES failed${out:+: $out}"
    sleep "$LAUNCHCTL_SLEEP"
  done
  die "could not register $label with launchd; try: launchctl bootstrap $GUI_DOMAIN $target"
}

# After a restart: the label must be registered (re-bootstrap it if launchd lost it).
ensure_loaded() {
  local label="$1" target="$PLIST_DIR/$1.plist"
  [[ "$DRY_RUN" == 1 ]] && return 0
  agent_loaded "$label" && return 0
  warn "$label is not registered with launchd; bootstrapping it again"
  bootstrap_agent "$label" "$target"
}

# What launchd thinks of the label (for a failed health check).
agent_state() {
  local label="$1"
  if agent_loaded "$label"; then
    launchctl print "$GUI_DOMAIN/$label" 2>&1 | grep -E '^\s*(state|pid|last exit code|runs|path|program) =' | sed 's/^/    /' >&2 || true
  else
    warn "$label is NOT registered with launchd (launchctl print found nothing)"
  fi
}

# Render a template into ~/Library/LaunchAgents and (re)load it if it changed.
# Prints "changed" or "unchanged".
install_agent() {
  local label="$1" template="$2" target new
  target="$PLIST_DIR/$label.plist"
  if [[ "$DRY_RUN" == 1 ]]; then
    run "$REPO/scripts/render-plist.sh" "$template" --out "$target"
    run launchctl bootout "$GUI_DOMAIN/$label"
    run launchctl bootstrap "$GUI_DOMAIN" "$target"
    echo changed
    return
  fi
  new="$(mktemp)"
  "$REPO/scripts/render-plist.sh" "$template" --out "$new" >&2
  if [[ -f "$target" ]] && cmp -s "$new" "$target" && agent_loaded "$label"; then
    rm -f "$new"
    echo unchanged
    return
  fi
  mkdir -p "$PLIST_DIR"
  mv "$new" "$target"
  chmod 644 "$target"
  unload_agent "$label"
  bootstrap_agent "$label" "$target"
  echo changed
}

wait_healthy() {
  [[ "$DRY_RUN" == 1 ]] && { run curl -fsS "$HEALTH_URL"; return 0; }
  local i
  for i in $(seq 1 "$HEALTH_WAIT_S"); do
    if curl -fsS -o /dev/null --max-time 2 "$HEALTH_URL"; then
      say "healthy: $HEALTH_URL (after ${i}s)"
      # The Mastra API has no auth: it must only listen on loopback.
      if lsof -nP -iTCP:4111 -sTCP:LISTEN | awk 'NR>1 {print $9}' | grep -qv '^127\.0\.0\.1:'; then
        die "port 4111 is listening on a non-loopback address; stop the service and check HUB_HOST"
      fi
      return 0
    fi
    sleep 1
  done
  warn "service did not become healthy in ${HEALTH_WAIT_S}s; see $LOG_DIR/hub.err.log"
  say "launchd state of $HUB_LABEL:"
  agent_state "$HUB_LABEL"
  tail -n 30 "$LOG_DIR/hub.err.log" 2>/dev/null || true
  return 1
}
