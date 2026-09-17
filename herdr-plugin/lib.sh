#!/usr/bin/env bash
# Shared helpers for the Agent Router Herdr plugin.

set -euo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PLUGIN_ID="${HERDR_PLUGIN_ID:-nidhi-singh02.agent-router}"
HERDR="${HERDR_BIN_PATH:-herdr}"

# Resolve the router CLI: an explicit override, a global install, or the build
# inside this plugin checkout.
router() {
  if [ -n "${ROUTER_BIN:-}" ]; then
    "$ROUTER_BIN" "$@"
  elif command -v router >/dev/null 2>&1; then
    command router "$@"
  elif [ -f "$PLUGIN_ROOT/packages/router/dist/cli.js" ]; then
    node "$PLUGIN_ROOT/packages/router/dist/cli.js" "$@"
  else
    echo "router CLI not found." >&2
    echo "Build it with 'npm ci && npm run build' in $PLUGIN_ROOT, or set ROUTER_BIN." >&2
    return 127
  fi
}

notify() {
  "$HERDR" notification show "$1" --body "$2" --sound "${3:-none}" >/dev/null 2>&1 || true
}

# Overlay panes close the moment the command exits, so hold them open until the
# user acknowledges.
hold() {
  echo
  read -r -p "Press Enter to close… " _ || true
}
