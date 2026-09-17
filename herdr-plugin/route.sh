#!/usr/bin/env bash
# Prompt for a task, route it, and launch the chosen agent in a new pane.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Agent Router — route a task"
echo "Describe the task. Empty input cancels."
echo
read -r -p "task> " task || task=""

if [ -z "${task// /}" ]; then
  echo "Cancelled."
  exit 0
fi

echo
if router run "$task"; then
  notify "Agent Router" "Launched an agent for: ${task:0:60}" done
else
  notify "Agent Router" "Routing failed — see the pane for details" request
  hold
  exit 1
fi

hold
