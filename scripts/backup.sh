#!/usr/bin/env bash
# Consistent snapshot of the hub's LibSQL database, keeping the newest N copies.
# Also trims the service logs so they can't grow without bound.
#
# Env: HUB_DATA_DIR, BACKUP_DIR, BACKUP_KEEP (default 7), LOG_DIR, LOG_MAX_BYTES (default 10 MB).
set -euo pipefail
umask 077

DATA_DIR="${HUB_DATA_DIR:-$HOME/Library/Application Support/assistant-hub}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/assistant-hub-backups}"
KEEP="${BACKUP_KEEP:-7}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/assistant-hub}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-10485760}"
DB="$DATA_DIR/mastra.db"
WORK=""

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { log "BACKUP_KEEP must be a positive integer"; exit 2; }

rotate_logs() {
  [[ -d "$LOG_DIR" ]] || return 0
  local f size
  for f in "$LOG_DIR"/hub.out.log "$LOG_DIR"/hub.err.log; do
    [[ -f "$f" ]] || continue
    size="$(stat -f %z "$f")"
    if (( size > LOG_MAX_BYTES )); then
      # copy + truncate: launchd keeps the file descriptor open, so don't move it.
      cp "$f" "$f.1" && : >"$f"
      log "rotated $(basename "$f") ($size bytes)"
    fi
  done
}

main() {
  if [[ ! -f "$DB" ]]; then
    log "no database at $DB; nothing to back up"
    rotate_logs
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true

  local stamp target tmp
  stamp="$(date '+%Y%m%d-%H%M%S')"
  target="$BACKUP_DIR/mastra-$stamp.db"
  # Build the snapshot outside the (iCloud-synced) backup folder so sqlite's sidecar
  # files never land there, then move the finished file in.
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  tmp="$WORK/snapshot.db"

  # sqlite's online backup is consistent even while the hub is writing (WAL mode).
  sqlite3 "$DB" ".timeout 10000" ".backup '$tmp'"
  # A single self-contained file: no -wal/-shm sidecars in the backup folder.
  sqlite3 "$tmp" 'PRAGMA journal_mode=DELETE;' >/dev/null
  if [[ "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" != "ok" ]]; then
    log "integrity check failed; backup discarded"
    exit 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$target"
  log "wrote $target ($(stat -f %z "$target") bytes)"

  # Keep the newest $KEEP snapshots (names sort chronologically).
  local all=() f
  while IFS= read -r f; do all+=("$f"); done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'mastra-*.db' -type f | sort)
  local excess=$(( ${#all[@]} - KEEP ))
  if (( excess > 0 )); then
    for f in "${all[@]:0:excess}"; do
      rm -f "$f"
      log "pruned $(basename "$f")"
    done
  fi

  rotate_logs
}

main "$@"
