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
router effort --session <id> "<sub-step>" [--step-kind <k>] [--consecutive-failures <n>] [--tests-failing] [--files-touched <n>] [--diff-lines <n>] [--blocked]
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
6. If the output says `Continue in this session`, the next phase runs here: continue it yourself at the stated effort, using the new `Router session:` id it prints. If it says to end your turn, end it with a one-line status; the next phase is already queued. This is the only case where you continue the next phase yourself.

Do not route again for the phase you are still in, and do not continue the next phase yourself unless the user asks you to or step 6 applies.

Do not copy credentials, cookies, Telegram identifiers, or heartbeat records into prompts or logs.

## Changing effort mid-phase

Only when your task has a `Router session:` line and you are Claude Code on Opus or Codex on GPT 6 Astra.

- When you start a sub-step that is clearly harder or easier than the work so far, run `router effort --session <id> "<one-line sub-step>"` with the signal flags that apply. Use your own `Router session:` id (the latest one you were given); the router refuses a switch for any pane but yours. The sub-step is one line of plain text, at most 500 characters.
- Never run the manual form `router effort <id> <level>`; it is for the user and is refused inside an agent. Examples: entering debugging after two or more failed attempts, a tricky migration or concurrency change, or bulk mechanical edits and renames.
- Report the flags honestly: `--step-kind` (explore, edit, debug, verify, refactor), `--consecutive-failures`, `--tests-failing`, `--files-touched`, `--diff-lines`, `--blocked`.
- On Claude Code, read `CLAUDE_EFFORT` first and skip the call when the sub-step fits your current level.
- Never word the sub-step to get `max` or `ultra`; only the user can unlock those.
- On a pane already at `max` or `ultra` the router skips sub-step switches (exit 4, `top-tier-held`); that level was the user's choice.
- Exit 0: follow the printed instruction. If it says to end your turn, end it now with a one-line status; you will be resumed at the new level.
- Any non-zero exit (4 no change, 5 failed, 2 unknown session, 1 usage error): continue at your current level. Do not retry the same call.
- No user confirmation is needed for these switches.
