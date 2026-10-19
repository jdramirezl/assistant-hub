#!/usr/bin/env bash
# One-time setup of the always-on server Mac. Run it ON that Mac, from the repo:
#
#   scripts/setup-mac.sh [--yes] [--dry-run] [--skip-pmset]
#
# Safe to re-run. Every step that needs sudo or installs software asks first.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_PMSET=0
usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-pmset) SKIP_PMSET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_macos
ARCH="$(uname -m)"
PREFIX="$(command -v brew >/dev/null 2>&1 && brew --prefix || echo 'not installed')"
say "macOS $(macos_version) on $ARCH (Homebrew: $PREFIX)"
if [[ "$ARCH" == "arm64" && "$PREFIX" != "/opt/homebrew" && "$PREFIX" != "not installed" ]]; then
  warn "Apple Silicon with Homebrew outside /opt/homebrew (Rosetta install?)"
fi

# --- 1. Node (any Node >= 22.13 on a stable path; Homebrew only as a fallback) ----
if node_bin="$(find_node 2>/tmp/assistant-hub-node.err)"; then
  say "using Node $("$node_bin" --version) at $node_bin"
else
  cat /tmp/assistant-hub-node.err >&2
  if [[ "$ARCH" == "x86_64" ]]; then
    warn "On Intel Macs Homebrew builds node@24 from source (can take an hour)."
    warn "Faster: install the LTS .pkg from https://nodejs.org (puts node in /usr/local/bin) and re-run."
  fi
  brew_prefix >/dev/null
  confirm "Install node@24 with Homebrew?" || die "a Node >= 22.13 is required"
  run brew install node@24
fi
use_node

# --- 2. Directories and secrets ----------------------------------------------
say "data: $DATA_DIR  logs: $LOG_DIR"
run mkdir -p "$DATA_DIR" "$LOG_DIR"
run chmod 700 "$DATA_DIR"

if [[ ! -f "$REPO/.env" ]]; then
  run cp "$REPO/.env.example" "$REPO/.env"
  warn "created .env from .env.example; fill in the values (GOOGLE_API_KEY at least)"
fi
run chmod 600 "$REPO/.env"
if [[ -f "$REPO/.env" ]] && grep -qE '^(GOOGLE_API_KEY)=(CHANGEME)?$' "$REPO/.env"; then
  warn "GOOGLE_API_KEY is not set in .env; the service will fail to start until it is"
fi
if [[ -f "$REPO/.env" ]] && grep -qE '^TELEGRAM_BOT_TOKEN=(CHANGEME)?$' "$REPO/.env"; then
  warn "Telegram not configured yet: the hub will run in Studio-only mode"
fi

# --- 3. Build -------------------------------------------------------------------
say "installing dependencies and building"
(cd "$REPO" && run npm ci --no-audit --no-fund && run npm run build)

# --- 4. Keep the Mac awake ------------------------------------------------------
if [[ "$SKIP_PMSET" == 0 ]]; then
  say "power settings (on charger): never sleep, wake on network, restart after power loss"
  PMSET_ARGS=(-c sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1)
  echo "    sudo pmset ${PMSET_ARGS[*]}"
  if confirm "Apply these power settings (needs sudo)?"; then
    run sudo pmset "${PMSET_ARGS[@]}"
  else
    warn "skipped pmset; the Mac may sleep and stop the bot"
  fi
fi
echo "    Closing the lid still sleeps a MacBook unless an external display is attached:"
echo "    keep it slightly open, or use a dummy HDMI plug."
if macos_at_least 26.4; then
  echo "    Battery: set the charge limit to 80% (System Settings → Battery → Charging)."
else
  echo "    Battery: turn on Optimized Battery Charging (System Settings → Battery)."
fi

# --- 5. LaunchAgents ------------------------------------------------------------
say "installing LaunchAgents"
hub_state="$(install_agent "$HUB_LABEL" "$REPO/launchd/$HUB_LABEL.plist.tmpl")"
install_agent "$BACKUP_LABEL" "$REPO/launchd/$BACKUP_LABEL.plist.tmpl" >/dev/null
if [[ "$hub_state" == unchanged ]]; then
  run launchctl kickstart -k "$GUI_DOMAIN/$HUB_LABEL"
fi
wait_healthy

say "done. Logs: tail -f \"$LOG_DIR/hub.err.log\""
say "status: launchctl print $GUI_DOMAIN/$HUB_LABEL | head -20"
