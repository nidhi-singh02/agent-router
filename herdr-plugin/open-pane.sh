#!/usr/bin/env bash
# Open one of this plugin's panes. Used by the manifest actions so every
# surface is reachable from a keybinding.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

entrypoint="${1:?usage: open-pane.sh <entrypoint-id>}"
exec "$HERDR" plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$entrypoint"
