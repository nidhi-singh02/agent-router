#!/usr/bin/env bash
# List recent router sessions, then show one in full.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Agent Router — recent sessions"
echo
router session --list --limit "${ROUTER_SESSION_LIMIT:-20}" || true

echo
echo "Enter a session id to see its detail, or leave it empty to close."
read -r -p "session id> " session || session=""

if [ -n "${session// /}" ]; then
  echo
  router session "$session" || true
fi

hold
