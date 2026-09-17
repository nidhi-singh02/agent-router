---
name: model-router
description: Use when the user asks to pick a model, subscription, or reasoning effort, or to run router status, usage refresh, or resume a router session. Also use when you were launched by model-router (your task has a "Router session:" line) and your phase is complete, to route the next phase. Invoke the model-router CLI instead of choosing a model yourself.
---

# Model Router

Call the explicit CLI. Do not invent routing policy, quotas, or model catalogs.

## Invoke

```sh
router run "<task>" --dry-run
router run "<task>"
router run --session <id> "<next-phase task>"
router status [--usage]
router session [id] [--list]
router accounts
router usage refresh --dry-run
router usage refresh --source browser --dry-run
```

`--dry-run` prints the decision and does not create a Herdr pane or consume launch quota.

`router run` without `--dry-run` still requires `HERDR_ENV=1` and should wait for user confirmation before any launch that would consume subscription quota.

Default `router run` reads local-session quota caches. Add `--usage` for official CLI/API and browser collectors. Personal accounts stay eligible without known quota. Shared accounts still need known usage.

If the CLI prints two eligible routes, ask the user to choose. If it prints exclusions, report those reasons. Never override the 40% shared reserve.

## End of a phase

If your task was launched by model-router, it ends with `Router session: <id>`. When the phase you were given is complete (for example planning is done and implementation is next):

1. Write the result the next agent needs to a file in the repo, such as the plan or handoff notes (for example `docs/plans/<feature>.md`). The next agent starts in a new pane and does not see this conversation.
2. Tell the user the phase is complete, name the file, and ask whether to route the next phase. Do not launch anything until they agree.
3. Run `router session <id>` and confirm the phase and route you were given.
4. Run `router run --session <id> "<next-phase task>" --dry-run`. The task must name the next phase and reference the file, for example `Implement the approved plan in docs/plans/billing.md`. Show the user the decision card.
5. If the user confirms, run the same command without `--dry-run`. Report the new session id, agent, and pane from the output.

Do not route again for the phase you are still in, and do not continue the next phase yourself unless the user asks you to.

Do not copy credentials, cookies, Telegram identifiers, or heartbeat records into prompts or logs.
