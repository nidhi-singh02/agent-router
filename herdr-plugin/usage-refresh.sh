#!/usr/bin/env bash
# Refresh local-session quota snapshots for every configured account.
# Headless: output goes to the plugin command log.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

source_kind="${ROUTER_USAGE_SOURCE:-local-session}"

if output="$(router usage refresh --source "$source_kind" 2>&1)"; then
  echo "$output"
  notify "Agent Router" "Usage refreshed ($source_kind)" done
else
  echo "$output" >&2
  notify "Agent Router" "Usage refresh failed ($source_kind)" request
  exit 1
fi
