#!/usr/bin/env bash
# Update the running service on the server Mac. Run it ON that Mac, from the repo:
#
#   scripts/deploy.sh [--skip-tests] [--dry-run]
#
# pull (fast-forward only) → npm ci → npm test → npm run build → restart → health check.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_TESTS=0
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_macos
use_node
cd "$REPO"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "uncommitted changes in $REPO; commit or stash them before deploying"
fi

before="$(git rev-parse --short HEAD)"
say "pulling (was $before)"
run git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [[ "$before" == "$after" ]]; then
  say "already up to date at $after"
else
  say "updated $before → $after"
fi

run npm ci --no-audit --no-fund
if [[ "$SKIP_TESTS" == 0 ]]; then
  run npm test
fi
run npm run build

hub_state="$(install_agent "$HUB_LABEL" "$REPO/launchd/$HUB_LABEL.plist.tmpl")"
install_agent "$BACKUP_LABEL" "$REPO/launchd/$BACKUP_LABEL.plist.tmpl" >/dev/null
if [[ "$hub_state" == unchanged ]]; then
  say "restarting $HUB_LABEL"
  run launchctl kickstart -k "$GUI_DOMAIN/$HUB_LABEL"
else
  say "plist changed; service reloaded"
fi
wait_healthy
say "deployed $after"
