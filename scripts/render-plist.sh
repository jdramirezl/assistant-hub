#!/usr/bin/env bash
# Render a launchd plist template with this machine's absolute paths.
#
#   scripts/render-plist.sh <template> [--out <file> | --stdout]
#
# Overrides (env): NODE_BIN, HUB_DATA_DIR, LOG_DIR, BACKUP_DIR.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

resolve_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    printf '%s\n' "$NODE_BIN"
    return
  fi
  # Homebrew's opt/ symlink is stable across node@24 upgrades (a mise/nvm "latest" path is not).
  if command -v brew >/dev/null 2>&1; then
    local candidate
    candidate="$(brew --prefix)/opt/node@24/bin/node"
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  fi
  echo "render-plist: node@24 not found. Run scripts/setup-mac.sh or set NODE_BIN." >&2
  exit 1
}

# Escape a value for use as a sed replacement (we use | as the delimiter).
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

main() {
  local template="${1:-}"
  shift || true
  [[ -f "$template" ]] || { echo "usage: $0 <template> [--out <file> | --stdout]" >&2; exit 2; }

  local out="" to_stdout=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out) out="$2"; shift 2 ;;
      --stdout) to_stdout=1; shift ;;
      *) echo "render-plist: unknown argument $1" >&2; exit 2 ;;
    esac
  done

  local node node_dir data_dir log_dir backup_dir
  node="$(resolve_node)"
  node_dir="$(dirname "$node")"
  data_dir="${HUB_DATA_DIR:-$HOME/Library/Application Support/assistant-hub}"
  log_dir="${LOG_DIR:-$HOME/Library/Logs/assistant-hub}"
  backup_dir="${BACKUP_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/assistant-hub-backups}"

  for p in "$node" "$REPO" "$data_dir" "$log_dir" "$backup_dir"; do
    [[ "$p" == /* ]] || { echo "render-plist: path must be absolute: $p" >&2; exit 1; }
    # Keep the rendered XML valid without an escaping layer.
    [[ "$p" != *[\<\>\&]* ]] || { echo "render-plist: unsupported character in path: $p" >&2; exit 1; }
  done

  local rendered
  rendered="$(sed \
    -e "s|@NODE@|$(sed_escape "$node")|g" \
    -e "s|@NODE_DIR@|$(sed_escape "$node_dir")|g" \
    -e "s|@REPO@|$(sed_escape "$REPO")|g" \
    -e "s|@DATA_DIR@|$(sed_escape "$data_dir")|g" \
    -e "s|@LOG_DIR@|$(sed_escape "$log_dir")|g" \
    -e "s|@BACKUP_DIR@|$(sed_escape "$backup_dir")|g" \
    "$template")"

  if grep -q '@[A-Z_]*@' <<<"$rendered"; then
    echo "render-plist: unresolved placeholder in $template" >&2
    exit 1
  fi

  if [[ $to_stdout -eq 1 || -z "$out" ]]; then
    printf '%s\n' "$rendered"
  else
    mkdir -p "$(dirname "$out")"
    printf '%s\n' "$rendered" >"$out"
    chmod 644 "$out"
    plutil -lint -s "$out"
  fi
}

main "$@"
