#!/usr/bin/env bash
# Shared helpers for setup-mac.sh and deploy.sh. Source, don't execute.
# shellcheck shell=bash

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

node24_path() { printf '%s/opt/node@24/bin/node\n' "$(brew_prefix)"; }

# Make node@24 (keg-only) the node/npm used by this script.
use_node24() {
  local node
  node="$(node24_path)"
  [[ -x "$node" ]] || { [[ "$DRY_RUN" == 1 ]] && return 0; die "node@24 not installed (run scripts/setup-mac.sh)"; }
  PATH="$(dirname "$node"):$PATH"
  export PATH
  export NODE_BIN="$node"
}

agent_loaded() { launchctl print "$GUI_DOMAIN/$1" >/dev/null 2>&1; }

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
  agent_loaded "$label" && launchctl bootout "$GUI_DOMAIN/$label" >&2 || true
  launchctl bootstrap "$GUI_DOMAIN" "$target" >&2
  launchctl enable "$GUI_DOMAIN/$label" >&2
  echo changed
}

wait_healthy() {
  [[ "$DRY_RUN" == 1 ]] && { run curl -fsS "$HEALTH_URL"; return 0; }
  local i
  for i in $(seq 1 60); do
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
  warn "service did not become healthy in 60s; see $LOG_DIR/hub.err.log"
  tail -n 30 "$LOG_DIR/hub.err.log" 2>/dev/null || true
  return 1
}
