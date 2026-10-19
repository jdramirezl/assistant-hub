#!/usr/bin/env bash
# Pick the Node binary launchd will run. Source, don't execute.
# shellcheck shell=bash
#
# Order: NODE_BIN (env), NODE_BIN in .env, then stable install locations:
#   Homebrew node@24 / node, the nodejs.org installer (/usr/local/bin/node), `command -v node`.
# Requires Node >= 22.13. Version-pinned manager paths (nvm, volta, fnm, asdf/mise version dirs)
# are skipped unless set explicitly via NODE_BIN, because they disappear after an upgrade.

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13

node_version_ok() {
  local v major minor
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR) ))
}

node_path_stable() {
  [[ "$1" != *"/.nvm/versions/"* && "$1" != *"/.volta/tools/image/"* && "$1" != *"fnm"* \
    && ! "$1" =~ /installs/node/[0-9] && ! "$1" =~ /\.asdf/installs/ ]]
}

_node_from_env_file() {
  local file="${NODE_ENV_FILE:-${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}/.env}"
  [[ -f "$file" ]] || return 0
  sed -n 's/^NODE_BIN=//p' "$file" | tail -n 1 | tr -d '"'"'"
}

_node_candidates() {
  if [[ -n "${NODE_CANDIDATES+x}" ]]; then
    printf '%s\n' $NODE_CANDIDATES
    return
  fi
  if command -v brew >/dev/null 2>&1; then
    local prefix
    prefix="$(brew --prefix)"
    printf '%s\n' "$prefix/opt/node@24/bin/node" "$prefix/opt/node@22/bin/node" "$prefix/opt/node/bin/node"
  fi
  printf '%s\n' /usr/local/bin/node /opt/homebrew/bin/node
  command -v node 2>/dev/null || true
}

# Prints the chosen absolute node path; returns 1 with an explanation on stderr.
find_node() {
  local explicit
  explicit="${NODE_BIN:-$(_node_from_env_file)}"
  if [[ -n "$explicit" ]]; then
    [[ "$explicit" == /* && -x "$explicit" ]] || { echo "NODE_BIN must be an absolute path to an executable: $explicit" >&2; return 1; }
    node_version_ok "$explicit" || { echo "NODE_BIN $explicit is older than Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR" >&2; return 1; }
    printf '%s\n' "$explicit"
    return 0
  fi
  local c skipped=()
  while IFS= read -r c; do
    [[ -n "$c" && -x "$c" ]] || continue
    node_version_ok "$c" || continue
    if ! node_path_stable "$c"; then
      skipped+=("$c")
      continue
    fi
    printf '%s\n' "$c"
    return 0
  done < <(_node_candidates)
  for c in ${skipped[@]+"${skipped[@]}"}; do
    echo "skipped $c: version-specific path (breaks after an upgrade); set NODE_BIN=$c in .env to use it anyway" >&2
  done
  echo "no Node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR on a stable path. Install it from https://nodejs.org (LTS .pkg → /usr/local/bin/node), or 'brew install node@24', or set NODE_BIN in .env." >&2
  return 1
}
