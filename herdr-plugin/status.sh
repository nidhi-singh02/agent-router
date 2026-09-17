#!/usr/bin/env bash
# Show configured accounts, and optionally each account's quota.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Agent Router — status"
echo
router status || true

echo
read -r -p "Collect live quota too? [y/N] " answer || answer=""
case "$answer" in
  y | Y)
    echo
    router status --usage || true
    ;;
esac

hold
