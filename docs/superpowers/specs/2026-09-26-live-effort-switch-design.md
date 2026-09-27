# Live Effort Switching Design

**Date:** 2026-09-26
**Status:** implemented on `feat/live-effort-switch`; see "Implementation notes" for where the code differs from this design
**Scope:** `packages/router`, `skills/model-router`

## Problem

The router picks a reasoning effort once, at launch, and bakes it into the agent command
(`--effort <e>` for Claude Code, `-c model_reasoning_effort="<e>"` for Codex;
`launch/agent-command.ts`). The effort then stays fixed for the life of the pane. A new
phase always opens a new pane, which discards the conversation and the warm prompt cache
even when TypeSafe picks the same model again.

Claude Opus 5.5 (Claude Code 2.1.283) and GPT 6 Astra (codex-cli 0.156.1) can change
reasoning effort inside a running session without losing the conversation. A session is no
longer bound to one effort.

## Goal

Let TypeSafe (Jev) change the reasoning effort of a running Opus 5.5 or GPT 6 Astra pane:

1. at a phase boundary, by continuing in the same pane when the same route wins, and
2. within a phase, when the agent reports that its current sub-step is markedly harder or
   easier than the last.

Both models must show the same observable behavior: **the next model request after a
verified switch runs at the new level.**

## Non-goals

- **Model switching mid-session.** Effort only. Changing model breaks the prompt cache and
  changes the quota pool and reservation. The schema leaves room for it later.
- **Router-initiated polling.** The router never watches a pane per turn and never reads a
  transcript to decide on a switch.
- **Transcript egress.** No conversation text reaches TypeSafe.
- **Other models.** Cursor, Sonnet, OpenCode, and the other Codex models keep today's
  launch-time-only behavior.
- **Editing the user's settings.** The router never writes `~/.claude/settings.json` or
  `~/.codex/config.toml`.

## Decisions

| #   | Decision                | Choice                                                                                                                                                                 |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Triggers                | Phase boundary in place (same pane) + agent-invoked `router effort` per sub-step + manual `router effort <id> <level>`                                                 |
| D2  | Granularity             | Per sub-step, only when the agent asks, bounded by a cooldown                                                                                                          |
| D3  | Eligible models         | Hardcoded: `anthropic:claude-opus` (resolves to Opus 5.5 on the Anthropic API) and `openai:gpt-6-astra`                                                                |
| D4  | What changes            | Effort only                                                                                                                                                            |
| D5  | Direction               | Up and down                                                                                                                                                            |
| D6  | TypeSafe input          | Sub-step text, phase, current effort, and a fixed schema of agent-reported signals. No transcript                                                                      |
| D7  | Phase-boundary handover | Caller is the target pane: print "continue in place". Caller is elsewhere: switch, then prompt                                                                         |
| D8  | Timing                  | Applied immediately; mid-turn when the agent is the caller                                                                                                             |
| D9  | Top-tier unlock         | User-only: the root `router run` task text contains "ultra" (covers the whole session chain), or the manual override                                                   |
| D10 | Effort vocabulary       | Add `xhigh` and `max`. `xhigh` free; `max` and `ultra` gated                                                                                                           |
| D11 | Claude persistence      | Drive the `/effort` slider and press `s` (session only). Never type `/effort <level>`, which saves the user's default                                                  |
| D12 | Astra parity            | Same observable behavior as Opus; mechanism differs (turn break, see "Astra turn break")                                                                               |
| D13 | Records                 | Phase-boundary switch: linked session row, same `paneId`, `continuation: "in-place"`. Sub-step switch: `effort_changes` table                                          |
| D14 | Quota                   | Up-shift re-runs eligibility for that one account; down-shift always allowed; no new reservation for sub-step switches                                                 |
| D15 | Anti-flap               | No-op rejected before TypeSafe; confidence < 0.6 keeps current; ≥ 5 min between sub-step switches; ≤ 8 sub-step switches per session                                   |
| D16 | Signals                 | Fixed, all-optional schema; unknown fields rejected                                                                                                                    |
| D17 | Manual override         | `router effort <session-id> <level>`: no TypeSafe, bypasses cooldown, can reach the top tier                                                                           |
| D18 | Top tier reachability   | `max`/`ultra` only by launching a new pane, on both models (revised during implementation; see "Implementation notes"). In-place switches are limited to `low`–`xhigh` |
| D19 | Verification            | Match pane output, then confirm from the agent's session file. Retry once, then fail                                                                                   |
| D20 | Claude cache-warning    | Auto-decline, mark session `liveSwitchUnsupported`                                                                                                                     |
| D21 | Drift                   | Pane gone, different agent/model, or Codex Plan mode: stop; phase boundary falls back to a new pane                                                                    |
| D22 | Concurrency             | Per-session SQLite lock; agent caller fails fast, manual override waits ≤ 10 s                                                                                         |
| D23 | Busy input              | Non-empty input line: stop with `pane-input-busy`. Never clear it (`Escape` interrupts Claude)                                                                         |
| D24 | Exit codes              | 0 switched and verified, 4 no change, 5 switch failed                                                                                                                  |
| D25 | Rollout                 | Opt-in: `config.json` `liveEffort.enabled`, default `false`                                                                                                            |
| D26 | In-place condition      | Same account, same model, pane alive, session not `liveSwitchUnsupported`. Ranking unchanged                                                                           |
| D28 | Skill rules             | See "Skill changes"                                                                                                                                                    |

## Verified agent facts

Collected on 2026-09-26 from docs, binaries, and the Codex source at tag `rust-v0.156.1`.
The live smoke checklist re-verifies each one; the implementation must not rely on anything
marked unverified.

| Fact                   | Claude Code 2.1.283 (Opus 5.5)                                                                                                                                                                       | codex-cli 0.156.1 (GPT 6 Astra)                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Levels                 | `low, medium, high, xhigh, max` (default `medium`)                                                                                                                                                   | `low, medium, high, xhigh, max, ultra` (default `low`)                                                                                                      |
| Mid-session switch     | `/effort` slider (arrows); `s` applies to this session only. Typed `/effort <level>` saves `modelSettings.<model>.effortLevel` in `~/.claude/settings.json`. `max` is always session-only            | `Alt+.` / `Alt+,` (also `Shift+Up/Down`) step one level; not persisted. Ignored while a popup or approval modal is open. Raising never enters `max`/`ultra` |
| When it applies        | Runs immediately, even mid-turn (`immediate: true`); applies to the next request in the current turn                                                                                                 | `thread/settings/update`: from the **next user turn**. The running turn keeps the old level                                                                 |
| Top tier               | Slider                                                                                                                                                                                               | `/model` picker only (opens mid-turn; no inline arguments)                                                                                                  |
| Success text           | `Set effort level to <lvl> (this session only)`                                                                                                                                                      | None in the transcript; status line `model-with-reasoning` updates. Picker prints `Model changed to <model> <label>`                                        |
| Readback               | Status line JSON `effort.level`; `/effort current`; transcript JSONL `"effort"`, `"perTurnEffort"`; `CLAUDE_EFFORT` env var in Bash and hooks                                                        | Status line; rollout JSONL `turn_context.payload.effort` and `thread_settings_applied.thread_settings.reasoning_effort`                                     |
| Confirmation dialog    | Only without per-turn effort support (Bedrock, gateways) with a warm cache: title `Change effort level?`, buttons `Yes, switch to <level>` / `No, go back`; cancel prints `Kept effort level as <X>` | None. Plan mode: the shortcut changes only the Plan-mode effort                                                                                             |
| Conversation preserved | Yes; prompt cache kept on first-party API/subscription                                                                                                                                               | Yes (observed high → medium on one thread)                                                                                                                  |

Herdr: `herdr agent get/list` returns `agent_status` (`idle`, `working`, `blocked`, `done`,
`unknown`); `herdr agent wait --until idle`; `herdr agent send-keys`, `herdr pane send-text`;
`herdr pane read <id> --source recent|visible --lines N`; `herdr pane wait-output`.
`herdr agent prompt` refuses a blocked agent and does not track turns.

## Effort vocabulary

`ReasoningEffortSchema` (`domain/model-profile.ts:5`) becomes
`["none", "low", "medium", "high", "xhigh", "max", "ultra"]`.

`models.json`:

| Model                   | `supportedEfforts`                     |
| ----------------------- | -------------------------------------- |
| `anthropic:claude-opus` | `low, medium, high, xhigh, max`        |
| `openai:gpt-6-astra`    | `low, medium, high, xhigh, max, ultra` |
| all others              | unchanged                              |

`agent-command.ts`: `CLAUDE_EFFORTS` gains `xhigh` and `max`; `CODEX_EFFORTS` gains
`xhigh` and `max`.

**Gate.** `TOP_TIER = {max, ultra}`. Today `userRequestedUltra` is
`/\bultra\b/i.test(task)` on the current task (`commands/run.ts:308`), and the agent writes
the `--session` task, so an agent can unlock ultra itself. Replace it with a session-chain
flag:

- `topTierUnlocked` is computed once, from the **root** `router run` task text (a run
  without `--session`), and stored on that session.
- Continued sessions inherit it from the chain root; the continued task text never sets it.
- The manual override is the only other way to reach a top-tier level.

`effortQuestion` filters out every `TOP_TIER` level unless `topTierUnlocked`. The launch-time
path gets the same gate, so this also closes the existing hole.

## Architecture

```text
router run --session <id> "<next phase>"          router effort --session <id> "<sub-step>" [signals]
          │                                                   │               router effort <id> <level>
          ▼                                                   ▼                         │
   decideRoute (unchanged)                          EffortChangeService.decide ◀────────┘ (manual: skip TypeSafe)
          │ same account+model, pane alive,                   │ gate, cooldown, cap, no-op,
          │ liveEffort.enabled, not unsupported               │ quota recheck, TypeSafe effort question
          ▼                                                   ▼
                     LiveEffortSwitcher.apply(pane, agent, from, to, callerIsTarget)
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   ClaudeEffortDriver             CodexEffortDriver
   slider + `s`                   Alt+. / Alt+, steps (+ picker at idle for top tier)
            │                            │
            └──────────► verify ◀────────┘
                  pane output + session file readback
```

New modules under `packages/router/src/live-effort/`:

| Module                     | Responsibility                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `eligibility.ts`           | `LIVE_EFFORT_MODELS` set, `liveEffort.enabled`, `liveSwitchUnsupported`, pane liveness      |
| `effort-change-service.ts` | Rules D14–D18, the TypeSafe effort question, `effort_changes` writes, the lock              |
| `switcher.ts`              | Pre-checks (idle/working, input line, Plan mode), dispatch to a driver, verification, retry |
| `claude-driver.ts`         | Slider keystrokes, cache-dialog detection and decline, readback                             |
| `codex-driver.ts`          | Shortcut steps, picker path for top tier, Plan-mode detection, turn break, readback         |
| `readback.ts`              | Claude transcript JSONL and Codex rollout JSONL readers (read-only, bounded tail reads)     |
| `signals.ts`               | zod schema for the signal fields                                                            |

`HerdrClient` (`launch/herdr-client.ts`) gains `sendKeys`, `sendText`, `readPane`,
`waitOutput`, and `getAgent` wrappers. All arguments are passed as argv, never through a
shell.

## Flows

### Phase boundary in place

Runs inside `router run --session <id>` after `decideRoute` returns.

1. If `liveEffort.enabled` is false, the route is not for the previous session's account
   and model, the recorded pane is not alive, or the session is `liveSwitchUnsupported`,
   continue exactly as today (new pane).
2. `--dry-run`: the card adds `Continuation: in-place (pane <id>), effort <from> -> <to>`.
   No keystrokes are sent. The existing confirm-then-launch flow stays.
3. Acquire the session lock. Re-check pane identity: it exists, runs the recorded agent
   kind, and has the recorded agent name.
4. Reserve capacity as for any run.
5. **Caller is the target pane** (`HERDR_PANE_ID` equals the recorded `paneId`):
   - Opus: apply the switch now (mid-turn), verify, print
     `Continue in this session: phase <phase>, effort now <to>.` Exit 0.
   - Astra: take the turn-break path (below) with the next-phase task as the continuation.
6. **Caller is another pane or the user:** wait for the target to be idle, apply, verify,
   then `herdr agent prompt` the next-phase task with the usual handoff text.
7. Write a new session row: `previousSessionId`, same `paneId` and `agentName`,
   `continuation: "in-place"`, new effort.
8. Any failure in 3–6 before the prompt is sent: release nothing that wasn't taken, record
   the reason, and fall back to a normal new-pane launch (it still needs the user's
   confirmation, which was already given for this command).

If the effort is unchanged, steps 5–6 skip the switch and only hand over the task.

### Sub-step switch

`router effort --session <id> "<sub-step>" [--step-kind …] [--consecutive-failures N]
[--tests-failing] [--files-touched N] [--diff-lines N] [--blocked] [--json]`

1. If `liveEffort.enabled` is false or the model isn't eligible: exit 4 `disabled`.
2. Acquire the session lock (fail fast: exit 5 `switch-in-progress`).
3. Cooldown and cap checks: exit 4 `cooldown` or `switch-cap`.
4. `assertSafeState` over the sub-step text and signals.
5. Ask TypeSafe the effort question with state
   `{ subStep, phase, currentEffort, signals }`. The allowed choices are the model's levels
   minus `TOP_TIER`.
6. The chosen level equals the current level, or confidence < 0.6: exit 4 `no-change`
   / `low-confidence`.
7. Up-shift: re-run the policy filter for that account alone. If it fails: exit 4 `quota`.
8. Apply through the switcher and verify.
9. Write the `effort_changes` row. Exit 0 or 5.

The command's human-readable output always ends with one instruction the agent can follow
directly: `Continue at <level>.`, or on Astra `End your turn now with a one-line status;
you will be resumed at <level>.`

### Manual override

`router effort <session-id> <level> [--json]`

Skips TypeSafe, the cooldown, and the cap. Top-tier levels are allowed but require an idle
pane (D18). The lock waits up to 10 s. Quota recheck still applies to up-shifts. The
`effort_changes` row records `source: "manual"`.

### Astra turn break

Codex applies a shortcut change from the next user turn, so a mid-turn Astra switch needs a
turn boundary:

1. Press the shortcut steps now (allowed mid-turn when no popup is open).
2. Verify the status line shows the new level.
3. Queue the continuation (`Continue: <sub-step>` or the next-phase task) as a Codex queued
   message, so Codex sends it when the current turn ends. **If the smoke test shows the queue
   path does not work**, spawn a detached waiter instead: it waits for `idle`, then sends the
   continuation with `herdr agent prompt`. The waiter exits after 10 minutes, or as soon as
   the pane goes `working` from input it didn't send.
4. Tell the agent to end its turn with a one-line status.
5. After the continuation turn starts, confirm `turn_context.payload.effort` in the rollout.
   A mismatch is recorded as `failed: readback-mismatch` on the `effort_changes` row.

Opus does not use the turn break; its switch applies within the turn.

## Pre-checks (both drivers)

Before any keystroke:

| Check                                                 | Failure                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pane exists and runs the recorded agent name and kind | `pane-drift`                                                                                |
| `agent_status` is not `blocked`                       | `pane-blocked`                                                                              |
| Top-tier target and pane not `idle`                   | `top-tier-requires-idle`                                                                    |
| Input line empty (from `pane read --source visible`)  | `pane-input-busy`                                                                           |
| Codex: not in Plan mode                               | `codex-plan-mode`                                                                           |
| Codex: no popup or modal open                         | `pane-modal-open`                                                                           |
| Readback of current effort matches the recorded level | `effort-drift` (the recorded level is updated from the readback, then the switch continues) |
| Readback shows a different model                      | `pane-drift`                                                                                |

## Verification

| Agent | Primary                                                                            | Confirm                                                                          |
| ----- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Opus  | `pane wait-output` for `Set effort level to <to> (this session only)`, 5 s timeout | Latest transcript JSONL entry `"effort"` equals `<to>` on the next request       |
| Astra | Status line `model-with-reasoning` shows `<to>`, 5 s timeout                       | Rollout `thread_settings_applied.thread_settings.reasoning_effort` equals `<to>` |

On a mismatch, retry once from a fresh readback. A second mismatch is `failed:
verify-mismatch`. A switch is never recorded as applied without a primary match.

Claude dialog: if `Change effort level?` appears, send the key for `No, go back`, wait for
`Kept effort level as`, record `failed: cache-warning`, and set `liveSwitchUnsupported` on
the session chain. The router never confirms that dialog.

## Data

Migration `003_live_effort.sql`:

```sql
CREATE TABLE effort_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  source TEXT NOT NULL CHECK (source IN ('agent', 'manual', 'phase-boundary')),
  from_effort TEXT NOT NULL,
  to_effort TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'no-change', 'failed', 'pending')),
  reason TEXT NOT NULL,
  confidence REAL,
  signals_json TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX effort_changes_session ON effort_changes(session_id, created_at);

CREATE TABLE effort_locks (
  session_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

The sub-step text is not stored; only the TypeSafe state's structured fields are, matching
how routing tasks are already handled. Stale locks expire after 60 s.

Session payload gains optional `continuation: "in-place"`, `topTierUnlocked: boolean`, and
`liveSwitchUnsupported: boolean`. All are optional, so existing session rows still parse
(see the handoff-schema warning in `2026-09-18-task-enrichment-design.md`).

`router session <id>` shows an `Effort history` section; `--json` adds `effortChanges`.

## Signals schema

```ts
const SignalsSchema = z
  .object({
    stepKind: z.enum(["explore", "edit", "debug", "verify", "refactor"]).optional(),
    consecutiveFailures: z.number().int().min(0).max(100).optional(),
    testsFailing: z.boolean().optional(),
    filesTouched: z.number().int().min(0).max(10_000).optional(),
    diffLines: z.number().int().min(0).max(1_000_000).optional(),
    blocked: z.boolean().optional(),
  })
  .strict();
```

`filesTouched` and `diffLines` go to TypeSafe as buckets (`0`, `1-5`, `6-20`, `21+` files;
`<50`, `50-300`, `300-1000`, `1000+` lines), matching the enrichment rule that raw counts
are not sent.

## Output and exit codes

| Code | Meaning                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Switched and verified (or Astra: switched, continuation queued)                                                                                         |
| 4    | No change: `disabled`, `no-change`, `low-confidence`, `cooldown`, `switch-cap`, `quota`, `top-tier-gated`, `top-tier-requires-idle`                     |
| 5    | Failed: `switch-in-progress`, `pane-drift`, `pane-blocked`, `pane-input-busy`, `pane-modal-open`, `codex-plan-mode`, `cache-warning`, `verify-mismatch` |

`--json`: `{ sessionId, from, to, status, reason, turnBreak: boolean }`. Reasons are a closed
vocabulary.

## Skill changes

`skills/model-router/SKILL.md` gains a "Changing effort mid-phase" section:

- Call `router effort --session <id> "<sub-step>"` when starting a sub-step that is clearly
  harder or easier than the current one: for example, entering debugging after two or more
  failed attempts, a tricky migration or concurrency change, or bulk mechanical edits.
- Pass the signal flags honestly.
- On Claude, read `CLAUDE_EFFORT` first and don't call when the sub-step fits the current
  level.
- Never add text meant to unlock `max` or `ultra`.
- Exit 4 or 5: continue at the current level and don't retry the same call.
- When the output says to end the turn, end it with a one-line status.
- No user confirmation is needed for sub-step switches.

The "End of a phase" section adds: when `router run --session` prints
`Continue in this session`, continue the next phase in this session. This is the one
exception to "do not continue the next phase yourself".

## Failure matrix

| Situation                                        | Sub-step switch                         | Phase boundary                             |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------ |
| Feature disabled / model not eligible            | exit 4 `disabled`                       | New pane (today's behavior)                |
| Pane gone or different agent/model               | exit 5 `pane-drift`                     | New pane                                   |
| Pane blocked on an approval                      | exit 5 `pane-blocked`                   | New pane                                   |
| Input line not empty                             | exit 5 `pane-input-busy`                | New pane                                   |
| Codex Plan mode or popup open                    | exit 5                                  | New pane                                   |
| Claude cache-warning dialog                      | Decline, exit 5, mark unsupported       | Decline, mark unsupported, new pane        |
| Verification fails twice                         | exit 5 `verify-mismatch`                | New pane                                   |
| TypeSafe unavailable                             | exit 4 `no-change` (no fallback switch) | Today's `typesafe-unavailable` handling    |
| Quota recheck fails on up-shift                  | exit 4 `quota`                          | Today's routing already excluded the route |
| Astra continuation never runs (waiter timed out) | `effort_changes.status = failed`        | Session row records `continuation-timeout` |

## Testing

- **Fake Herdr client** with scripted pane-output fixtures: Claude slider success; Claude
  cache dialog and decline; Codex shortcut steps up and down; Codex clamp message at the
  limit; Codex Plan mode; busy input line; blocked pane; verification mismatch then success;
  verification mismatch twice.
- **Unit tests:** `topTierUnlocked` from the root task only (a continued task containing
  "ultra" does not unlock); effort question excludes top tier on sub-step; cooldown and
  cap; confidence threshold; no-op short-circuit before TypeSafe; up-shift quota recheck;
  down-shift skips it; signals schema rejects unknown fields; bucket mapping.
- **Session tests:** existing rows without the new fields still parse; `effort_changes`
  written for each outcome; lock expiry.
- **Phase-boundary tests:** in-place chosen only when account, model, pane, and flags match;
  caller-is-target vs other caller; every fallback path launches a new pane.
- **Live smoke checklist** `docs/validation/2026-09-xx-live-effort-smoke.md`, run by hand in
  real Opus 5.5 and Astra panes: each fact in "Verified agent facts", the Codex queued-message
  path (decides queue vs waiter), `~/.claude/settings.json` unchanged after a Claude switch
  (byte comparison), and that the prompt cache survives a Claude switch.

## Implementation notes

Written after implementation, from facts checked against Claude Code 2.1.283, codex-cli
0.156.1, and Herdr 0.9.0. Where these differ from the sections above, these win.

1. **Top tier starts only with a new pane (D18 revised).** The Codex `/model` picker, the
   only way to reach `max`/`ultra`, saves the chosen model and effort as the user's default,
   and its rows depend on the model catalog, so scripting it would break the rule not to touch
   user settings and would be fragile. For parity, Opus follows the same rule: when TypeSafe
   picks a top-tier level at a phase boundary the router launches a new pane with
   `--effort max` / `model_reasoning_effort="ultra"`, and `router effort <id> max` exits 4
   `top-tier-requires-new-pane`. The unlock rule (D9) is unchanged.
2. **Module layout.** `live-effort/` holds `levels.ts`, `pane-text.ts`, `signals.ts`,
   `switcher.ts` (both drivers, and `callerClaudeEffort`) and `in-place.ts`; the sub-step and
   manual flows live in `commands/effort.ts`. Herdr pane control is `HerdrPaneClient` in
   `launch/herdr-client.ts`.
3. **Claude slider.** `/effort` then Enter opens the slider; the router waits for its
   `s for this session only` hint before sending anything else (else `slider-not-opened`),
   presses left six times to pin it at `low`, right to the target, then `s`. Success is a
   _new_ `Set effort level to <x> (this session only)` line: output from an earlier switch
   is ignored by comparing the latest outcome line before and after.
4. **Readback.** Claude's current level comes from `CLAUDE_EFFORT` when the agent is the
   caller, else from the router's record; the transcript is not read (it lags a switch made
   on an idle pane). Codex's current level and the switch's confirmation both come from the
   status line (`GPT-6-Astra <level>`) in the footer. The Codex rollout readback in
   "Verification" is not implemented; without a status line the switch is not attempted.
5. **Astra turn break.** The continuation is flattened to one line, typed, and queued with
   Tab. The detached waiter fallback is not implemented: the Codex source queues
   Tab-submitted input while a turn runs. The smoke checklist (X3) confirms it live.
6. **Lock key.** Locks are keyed by pane, not session, since sessions continued in place
   share one pane.
7. **Pre-checks.** Codex popups are not detected up front; the shortcut ignores keys while a
   popup is open, so the switch ends in `verify-mismatch`. The input-line check reads the
   last prompt line (`❯` or `›`) and treats only dim (SGR 2) text as placeholder; anything
   else fails closed as `pane-input-busy`.
8. **Records.** `effort_changes` has no `pending` status or `verified_at`: a switch is
   recorded once, after verification. Extra closed-vocabulary reasons: `not-eligible`,
   `unsupported`, `already-at-level`, `unsupported-effort`, `unsafe-state`,
   `typesafe-unavailable`, `top-tier-requires-new-pane` (exit 4); `slider-not-opened`,
   `saved-default`, `effort-capped`, `verify-timeout`, `send-failed` (exit 5).
9. **Caller environment.** Only `HERDR_PANE_ID`, `CLAUDE_EFFORT`, `CLAUDECODE`,
   `CODEX_THREAD_ID` and `CODEX_SANDBOX` from the caller's environment are kept on the run
   deps (`liveEffortCallerEnv`).
10. **Review hardening (pre-landing review).**
    - An agent's `router effort --session` must come from the pane it switches
      (`not-caller-pane` otherwise), so sub-step text never reaches another agent.
    - Sub-steps are one plain-text line of at most 500 characters; typed text is stripped of
      control characters again, and Codex phase handoffs are queued as `Next phase: …`.
    - The manual form is refused when `CLAUDECODE`, `CODEX_THREAD_ID` or `CODEX_SANDBOX` is set.
    - Confirmations are read only from TUI chrome: Claude results after `⎿`, the dialog's
      title line alone, the slider hint and the Codex status in the bottom lines.
    - The Claude transcript is no longer read (it lags a switch on an idle pane); the level
      comes from `CLAUDE_EFFORT` when the agent calls, else from the router's record.
    - Every in-place handover goes through the switcher, so the pane is re-checked (agent,
      blocked, input box, vim normal mode) even when the level is unchanged.
    - A handoff prompt that cannot be confirmed as started is never followed by a new pane;
      the run exits 1 and names the pane to check.
    - All `router effort` decisions run under the pane lock on a fresh read of the session;
      lock TTLs cover the longest hold; a stray slider is closed with Escape; Codex retries
      only when the first burst changed nothing.
11. **Review pass 2.**
    - The caller checks (`HERDR_PANE_ID`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`) are
      guards against an agent acting in the wrong pane or in the user's name by mistake. They
      are not a security boundary: an agent with a shell can set or unset them.
    - `router run --session` from inside an agent hands a phase only to that agent's own pane
      (`not-caller-pane` otherwise); a caller counts as the target only when it is an agent.
    - A top-tier pane may continue in place at its own level; agent sub-step switches are
      refused on it (`top-tier-held`), since they would always lower the user's choice.
    - `router effort` refuses a session id superseded by a newer in-place phase in the same
      pane (`superseded-session`), and reports `not-in-herdr` outside Herdr.
    - A prompt Herdr refuses (`agent_blocked`, `agent_not_found`, `agent_not_ready`) falls
      back to a new pane; a timed-out one counts as delivered only if a turn starts. An
      unconfirmed handoff keeps its session live (`launched`, `continuation: in-place`) and its
      reservation, and the card says "handoff sent but not confirmed".
    - The slider must newly show its key-hint line (not a `⏺`/`⎿` conversation line) near the
      bottom; the outcome is read only once the slider has closed; the cache-warning dialog is
      looked for only at the bottom of the screen.
    - The `router effort` lock lasts about 200 s (TypeSafe's worst-case retries plus a switch)
      and the in-place lock is derived from its waits; both supersede the 60 s in "Data".
    - `--json`: `ok` is true only when the pane switched; exit 2 uses the same shape with
      `unknown-session` or `no-route`; `continuation` carries `self` and `handoff` when the
      calling agent continues on its own, and `unconfirmed` for an unconfirmed handoff.
12. **Review pass 3.** The top-tier hold and the quota check for a raise run in the switcher
    against the level read from the pane (Codex status line, or the calling Claude agent's
    `CLAUDE_EFFORT`), not only against the record; the superseded-session check is repeated
    under the lock; `sessions` gets an index for `latestForPane`; `router effort` counts the
    caller as the target only when it is an agent in that pane.
13. **Review pass 4.** `router run --session` refuses a superseded session id for in-place
    continuation (before planning and again under the lock), like `router effort`; a raise
    the quota refuses is reported as `quota` before any pane check, and the switcher checks
    again against the level it reads.
14. **Reasons.** `router effort` exit 4: `disabled`, `not-eligible`, `not-in-herdr`,
    `superseded-session`, `not-caller-pane`, `unsupported`, `unsupported-effort`,
    `top-tier-requires-new-pane`, `top-tier-held`, `top-tier-gated`, `already-at-level`,
    `low-confidence`, `cooldown`, `switch-cap`, `quota`, `unsafe-state`,
    `typesafe-unavailable`. Exit 5: `switch-in-progress`, `pane-drift`, `pane-blocked`,
    `pane-input-busy`, `codex-plan-mode`, `slider-not-opened`, `cache-warning`,
    `saved-default`, `effort-capped`, `verify-mismatch`, `verify-timeout`, `send-failed`, and
    `top-tier-requires-new-pane` when the pane itself shows a level that would need a top-tier
    move (the record said otherwise). Exit 2:
    `unknown-session`, `no-route`. `router run --json` `continuation.reason` (new pane):
    `disabled`, `no-live-pane`, `different-route`, `model-not-live`, `unsupported`,
    `new-worktree`, `not-caller-pane`, `superseded-session`, `top-tier-requires-new-pane`,
    `switch-in-progress`,
    `pane-busy`, `prompt-refused`, or any switcher failure above.

15. **Adversarial review.** A Codex queue that fails after a confirmed switch reports
    `applied` without a turn break (no second pane); a Claude level not reported by the calling
    agent never short-circuits a switch; Enter is sent only when the box reads `/effort`, after
    a fresh empty-input check and a successful baseline read; `Kept … as <target>` counts as
    already there; a late cache-warning dialog is declined; failed agent attempts start the
    cooldown; pane commands time out after 5 s; the in-place pane lock is released only after
    the new session is saved (or saving throws). Left for the smoke checklist: whether Codex's
    shell-tool timeout can cut `router effort` short, a `/model` change inside Claude (the
    slider then has fewer levels), and tool output that imitates TUI lines.

## Deferred

- Model switching in the same pane.
- Other models once their CLIs support session-only effort changes.
- A Codex path to `max`/`ultra` mid-turn (no supported mechanism today).
- Detecting Bedrock or gateway setups up front instead of via the dialog.
