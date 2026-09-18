# Task Enrichment Design

**Date:** 2026-09-18
**Status:** approved design, not yet implemented
**Scope:** `packages/router`
**Supersedes:** the first revision of this file (commit `c894da5`), which specified a
larger feature. Four reviews found twelve blocker-level defects in it; most attached to
parts of the feature that this revision removes. See "What was cut and why".

## Problem

The routing classifier sees only the raw prompt string. `decideRoute` builds its
classification state as `{ task, candidateCount }` (`semantic/decision-engine.ts:73`),
so "refactor PR 9" is indistinguishable from a one-line typo fix. Every downstream
judgment — task family, complexity, consequence, reasoning effort — is made without any
measurement of the work.

## Goal

When a prompt names a pull request in this repository, measure that PR's size and give
the classifier a bucketed summary of it.

That is the whole feature.

## Non-goals

- **File paths.** No path from any source enters classification state, the decision
  card, `result.json`, the session record, or a launched agent's prompt.
- **`handoff.relevantFiles`.** Stays `[]`. A separate spec, with a provenance gate
  designed in from the start.
- **Size-dependent cost.** `estimateTaskCostRatio` is untouched. See "Deferred".
- **Calibration.** Recording an advisory multiplier is in scope; consuming it is not.
- **Local `git` resolution.** No `git diff` branch. A PR reference resolves through
  `gh` or not at all.
- **Issue references.**
- **PR titles, bodies, branch names, head-repository fields.** Excluded at the query,
  never fetched.

## What was cut and why

| Cut                               | Reason                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relevantFiles` population        | A path passing charset validation still points at a file whose contents are attacker-authored, and an agent told a file is "relevant" opens it. Validation constrains spelling; the attack does not need spelling. Needs a provenance gate and its own spec. |
| `areas`, `extensions`, `spread`   | Derived from paths. As arrays of enums with unspecified ordering they carry ~232 bits of attacker-ordered data into TypeSafe state, defeating the "no free-form string field" safety argument.                                                               |
| Local `git diff --numstat` branch | An attacker-supplied `.gitattributes` marking a file `binary` makes numstat emit `-`, which `parseInt` turns into `NaN`, which zod rejects _after_ the agent has launched — orphaning it and leaking its reservation.                                        |
| `gh pr view --json files`         | Silently caps at 100 files, well under any byte cap, so a 441-file PR reports as complete. Only `changedFiles` (a scalar) is accurate.                                                                                                                       |
| Handoff schema constraint         | `session-repository` `get()`/`list()` parse stored payloads, so tightening the schema can brick existing session chains on read.                                                                                                                             |
| Submodule and worktree detection  | Fed only a bucket, and `result.json` had no field to render them into.                                                                                                                                                                                       |
| Memoization                       | Each `router run` is a separate process; an in-process memo cannot span a `--session` chain.                                                                                                                                                                 |
| Calibration loop                  | `reconcile` overwrites the ratio on every reservation for an account and returns nothing; `usageRefresh` has no access to sessions or reservations. Undesigned.                                                                                              |

## Decisions

| Decision        | Choice                                                  | Rationale                                                                                                                       |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Ref syntax      | `PR 9`, `pr #9`, `PR#9`. Never bare `#9`                | Bare `#9` is the canonical _issue_ form, and an unsolicited authenticated request should not fire on a prompt pasted from Slack |
| Resolution      | `gh` only                                               | No local branch means no worktree-sourced input                                                                                 |
| TypeSafe egress | Three scalar fields, all bucketed or boolean            | A raw churn count fingerprints a private diff                                                                                   |
| Cost estimate   | Unchanged constant                                      | Uncalibrated gating fails asymmetrically                                                                                        |
| Failure channel | `result.json` + decision card, closed-vocabulary reason | `stderr` is invisible under `--json`                                                                                            |
| Reason text     | Closed enum, never subprocess output                    | The CLI's output is read by launched agents, so it is a prompt surface                                                          |

### Why the cost gate is deferred

`estimatedCostRatio` feeds eligibility, `maxTotalRatio`, and `ReservationSchema.ratio`.
`reserveFloor` defaults to `0.4` for shared accounts (`domain/account.ts:27`). With
`claude-opus` at `relativeQuotaCost: 3`, the remaining quota required before a route is
permitted moves with the multiplier:

| Multiplier | Estimated cost | Remaining required |
| ---------- | -------------- | ------------------ |
| 1 (today)  | 0.06           | >= 0.46            |
| 2          | 0.12           | >= 0.52            |
| 4          | 0.24           | >= 0.64            |
| 8          | 0.48           | >= 0.88            |

The failure is asymmetric: too low costs nothing relative to today's flat estimate,
while too high hard-denies routes with a bare `code 2` naming no cause. This change
records what the buckets _would_ have estimated so a later change can calibrate against
observed consumption.

## Architecture

New module `packages/router/src/enrich/`:

| File              | Responsibility                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `ref-detector.ts` | Pure. Prompt -> `number[]` of PR numbers. No I/O.                 |
| `resolver.ts`     | One `gh` call via `runCommand`. Returns `Resolution`.             |
| `buckets.ts`      | Churn and file count -> `EnrichmentShapes` + advisory multiplier. |

### Types

```ts
// ref-detector.ts
export function detectPrRefs(task: string): number[];
// Matches /\b(?:PR|pr)\s*#?\s*(\d{1,7})\b/g. Never a bare "#9".
// Returns parsed integers, deduplicated, in order of appearance.

// resolver.ts
export type Resolution =
  | {
      status: "resolved";
      churn: number;
      changedFiles: number;
      prNumber: number;
      repo: { owner: string; name: string };
    }
  | { status: "skipped" }
  | { status: "unresolved"; reason: UnresolvedReason };

export type UnresolvedReason =
  | "no-refs"
  | "not-a-repository"
  | "gh-not-installed"
  | "gh-not-authenticated"
  | "github-unavailable"
  | "timed-out"
  | "pr-not-found"
  | "repo-mismatch"
  | "empty-diff"
  | "malformed-response";
// Closed enum. Never subprocess stdout or stderr.

// buckets.ts — the ONLY type decideRoute accepts. No string field, no array field.
export interface EnrichmentShapes {
  sizeBucket: "trivial" | "small" | "medium" | "large" | "very-large";
  fileCountBucket: "1" | "2-5" | "6-20" | "21-100" | "101+";
  truncated: boolean;
}
```

`EnrichmentShapes` contains no free-form string and no array, so it can carry neither a
path nor attacker-chosen ordering. Its full domain is 5 x 5 x 2 = 50 states.

### Thresholds

`churn = additions + deletions`, both from `gh pr view --json additions,deletions`.

| `sizeBucket` | churn   |
| ------------ | ------- |
| `trivial`    | 1-9     |
| `small`      | 10-49   |
| `medium`     | 50-249  |
| `large`      | 250-999 |
| `very-large` | 1000+   |

Churn `0` is `unresolved: empty-diff`, never `trivial`.

`fileCountBucket` from `changedFiles`: `1`, `2-5`, `6-20`, `21-100`, `101+`.

`advisoryMultiplier`, recorded only, never applied: `trivial` 0.5, `small` 1,
`medium` 2, `large` 4, `very-large` 8. Anchoring `medium` at twice today's flat estimate
keeps the deferred-gate table above directly comparable to future calibration data.

### Flow in `commands/run.ts`

1. `detectPrRefs(task)`. Empty -> `{ status: "skipped" }`, no subprocess.
2. Resolve the **first** detected ref only. At most one `gh` call per run.
3. `decideRoute` receives `enrichment?: EnrichmentShapes` as a typed parameter.
4. Eligibility, ranking, effort: unchanged logic. `estimateTaskCostRatio` untouched.
5. `result.json.enrichment` and one decision-card line.

`candidateCount` stays in the classification state. No reordering: nothing
model-produced feeds the cost estimate.

`enrichment` is added to the **classification** state (`decision-engine.ts:78`) and the
**effort** state (`:184`), because reasoning effort is where task size bears most
directly. It is _not_ added to the ranking state, which concerns account and model
capacity rather than task size.

## Resolver contract

One command:

```
gh pr view <n> --json additions,deletions,changedFiles,url,isCrossRepository
```

`gh pr diff --stat` does not exist: verified against gh 2.87.3, `gh pr diff` accepts
only `--color`, `--name-only`, `--patch`, `--web`.

Do not request `files`, `title`, `body`, `baseRefName`, `headRepository`, or
`headRepositoryOwner`. Exclusion at the query is checkable in review; exclusion at the
render site is not.

There is no `baseRepository` field. The base repository is parsed from `url`
(`https://<host>/<owner>/<repo>/pull/<n>`).

### Repository identity

- `git rev-parse --show-toplevel` must succeed. Its result is passed as an explicit
  `cwd` to every subprocess. Failure -> `not-a-repository`.
- `git remote get-url origin` in that `cwd` gives the local repository, parsed from the
  remote URL. This is a local command: `gh repo view` would be a second network call,
  contradicting the one-call limit below, and `gh pr view` already resolves against the
  local repository's remote, so the comparison confirms rather than discovers.
- The base repo parsed from the PR's `url` must equal it, case-insensitively.
  Mismatch -> `repo-mismatch`, and the resolution is discarded.
- If `origin` is absent, the comparison is skipped: `gh` resolved the PR from some
  remote of this repository.
- A non-`github.com` host in `url` is permitted only if it matches the host `gh`
  resolved for the local repo; otherwise `repo-mismatch`.
- `isCrossRepository` is recorded for the follow-up handoff spec. It has no effect here.

### Subprocess environment

The resolver constructs its environment explicitly. It must not pass `process.env`, and
must not reuse `sanitizeRuntimeEnv` (`commands/runtime.ts:36`), whose allowlist omits
`gh`'s auth variables.

Forwarded: `PATH`, `HOME`, `XDG_CONFIG_HOME`, `GH_TOKEN`, `GITHUB_TOKEN`, `LANG`,
`LC_ALL`, `TMPDIR`.

Explicitly **not** forwarded, because each redirects the request or the credential:
`GH_REPO` (accepts `[HOST/]OWNER/REPO`, the same redirect `-R` provides, via the
environment), `GH_HOST`, `GH_CONFIG_DIR`, `GH_PATH`, `GH_ENTERPRISE_TOKEN`, and
`GITHUB_ENTERPRISE_TOKEN`. The generic enterprise tokens apply to whichever enterprise
host the repository remote selects, so a repository-controlled origin could receive
them before the response-time identity check. Enterprise authentication therefore uses
`gh`'s host-specific credential store.

`gh` aliases and extensions need no handling: `gh alias set pr …` is refused because
`pr` is a core command, and extensions cannot override core commands.

## Security requirements

### S1 — Argument construction

`runCommand` uses `spawn` with an args array, so there is no shell injection. The
remaining risk is argument injection: `git` and `gh` treat any token starting with `-`
as an option.

- The only prompt-derived value reaching argv is a PR number, re-emitted as
  `String(parsed)` after `parseInt`, never the matched substring.
- `detectPrRefs` returns `number[]`, so no string from the prompt can reach argv by
  construction.
- Reject a parsed value that is not a finite positive integer below 10,000,000.

### S2 — Enrichment must never abort a route

`assertSafeState` is called at `semantic/decision-engine.ts:74`, outside the `try` that
opens at `:77`, so a throw escapes to `cli.ts:93` and exits 1.

- Every resolver failure returns an `UnresolvedReason`. Nothing throws.
- `JSON.parse` of `gh` output is wrapped; failure is `malformed-response`.
- Every numeric field is checked with `Number.isFinite` and rejected otherwise. `NaN`
  is a `number` to TypeScript and is rejected by zod, so an unchecked `NaN` becomes a
  throw at session-parse time, after the agent has already launched.
- No enrichment value may cause `RouterSessionSchema.parse` to fail. The recorded
  fields are the three `EnrichmentShapes` values plus two finite integers.

### S3 — Output is a prompt surface

The `model-router` skill instructs launched agents to run `router session <id>` and
`router run --session <id>`, so `output` and `result.json` are read by a model.

- `enrichment.reason` is an `UnresolvedReason` enum value. Never `gh` stdout or stderr.
- The card renders one line of fixed shape. `owner` must match `^[A-Za-z0-9-]{1,39}$`
  and `repo` `^[A-Za-z0-9._-]{1,100}$`; otherwise the repo is omitted from the line.
  A local checkout can itself be an attacker-named clone.

### S4 — Do not reuse `collectVerifiedStatus`

`collectors/verified-command.ts:22` does `raw = result.ok ? result.stdout : result.stderr`,
feeding an error message to the parser as data. It also hardcodes the collector timeout
and byte cap and passes no `env` or `cwd`. The resolver calls `runCommand` directly.

### S5 — Egress

`EnrichmentShapes` has 50 possible states, so at most ~5.6 bits per run describe a
private repository's diff to a third party. `docs/privacy.md` must be amended to record
this: it currently promises only that credentials are rejected.

`--no-enrich` disables resolution, and the same switch is settable in config so it can
be turned off permanently without per-invocation flags.

## Infrastructure changes

`collectors/command-runner.ts`:

- `runCommand` input gains `cwd?: string`.
- `CommandResult` gains `code: number | null` and `timedOut: boolean`, needed to
  distinguish failure-matrix rows.
- No change to overflow behavior. Killing the child on byte overflow would regress
  existing collectors, which currently truncate and return `ok: true`.

`commands/run.ts`: `RunDeps` gains `runCommand?: typeof runCommand`, defaulted to the
real implementation and threaded from the existing `RuntimeOverrides.runCommand`
(`commands/runtime.ts:95,149`). This is the test seam; the repo's established pattern is
parameter injection, not module mocking (`collectors/cursor/cursor-collector.ts:11`).

## Limits

- At most one PR ref resolved per run; at most one `gh` call per run.
- 2s per-call timeout and a 3s total budget across every subprocess in one run, so the
  three sequential calls cannot stack. `COLLECTOR_TIMEOUT_MS` (5s) is for local
  collectors, not a network hop on an interactive path.
- 64KB byte cap. The response is a handful of scalars, so the cap is a backstop only.
- No memoization; each run re-detects from its own task string.
- Enrichment runs under `--dry-run`: a dry run previews the route, and an unenriched
  preview previews a different route than the real one.
- Enrichment runs on a `--session` resume, re-detected from the new task string. Refs in
  one phase's prompt are not refs in the next phase's.
- No auto-skip under `--json`. Plugin consumers are the audience for an unresolved size.

## Failure matrix

| Case                             | `status`     | `reason`                      |
| -------------------------------- | ------------ | ----------------------------- |
| No PR ref in the prompt          | `skipped`    | — (no subprocess, no warning) |
| `cwd` not a repository           | `unresolved` | `not-a-repository`            |
| `gh` missing (ENOENT)            | `unresolved` | `gh-not-installed`            |
| `gh` not authenticated (exit 4)  | `unresolved` | `gh-not-authenticated`        |
| Any other non-zero exit          | `unresolved` | `github-unavailable`          |
| Timeout                          | `unresolved` | `timed-out`                   |
| PR does not exist, or is private | `unresolved` | `pr-not-found`                |
| Base repo != local repo          | `unresolved` | `repo-mismatch`               |
| `changedFiles` 0 or churn 0      | `unresolved` | `empty-diff`                  |
| Unparseable or non-finite JSON   | `unresolved` | `malformed-response`          |
| Resolved                         | `resolved`   | —                             |

Rate-limited and 5xx both exit 1 and are indistinguishable without reading stderr, which
S3 forbids, so they share `github-unavailable`.

Private-but-existing and not-found share `pr-not-found` so the CLI does not disclose
existence.

`truncated` is always `false` in this revision: `additions`, `deletions` and
`changedFiles` are scalars from the API and are never partial. The field is retained
because the follow-up handoff spec will need it.

## Output

`result.json` gains:

```ts
enrichment: {
  status: "skipped" | "resolved" | "unresolved";
  reason?: UnresolvedReason;
  prNumber?: number;
  repo?: string;          // "owner/name", validated per S3
  sizeBucket?: EnrichmentShapes["sizeBucket"];
  fileCountBucket?: EnrichmentShapes["fileCountBucket"];
  advisoryMultiplier?: number; // recorded for calibration, never applied
}
```

One decision-card line:

- resolved: `Task size: large (250-999 lines), 21-100 files (PR #9 in owner/repo)`
- unresolved: `Task size: unresolved (gh-not-authenticated)`
- skipped: line omitted

Nothing is written to `stderr` from `executeRun`.

## Prerequisite

Land first, separately: `assertSafeState` at `semantic/decision-engine.ts:74` throws
outside the `try`, producing a generic exit 1 on tainted user input.

Moving the call inside the existing `try` is **not** sufficient — it would route into
the `catch` at `:89-97`, returning `typesafe-unavailable`, which makes `run.ts:148-159`
print "TypeSafe could not select a route" plus `typesafeKeyHint`. A user whose prompt
tripped a credential regex would be told to store an API key.

Add a distinct `unsafe-state` status with its own message.

## Testing

Every failure-matrix row is a table test over fake `CommandResult` values injected
through `RunDeps.runCommand`. No network, no mocking.

- `detectPrRefs`: `PR 9`, `pr #9`, `PR#9`, bare `#9` rejected, `PRs 9, 10` (first only),
  leading zeros, values over the integer bound, no-match cases.
- Argv: the resolver's recorded command contains only `String(n)` and fixed flags.
- Env: the constructed environment contains no `GH_REPO`, `GH_HOST`, `GH_CONFIG_DIR`,
  or `GH_PATH`, and does contain `GH_TOKEN` when present in the parent.
- Buckets: boundary values 9/10, 49/50, 249/250, 999/1000; churn 0 -> `empty-diff`.
- Non-finite: a response with `additions: null` or a non-numeric value yields
  `malformed-response` and never throws.
- Repo identity: base/local mismatch yields `repo-mismatch` and discards the result.
- Egress: walk the entire recorded `state` on all three `systemOne` calls, skipping
  `task` **by key path** rather than by value shape, and fail on any other string
  containing `/` or matching a file-extension pattern. Scoping this to the enrichment
  subtree would assert only what the type already guarantees; walking the whole state is
  what catches an unforeseen field.
- `--dry-run` resolves; `--no-enrich` does not; `--json` includes the `enrichment` block.

Unchanged and asserted so: `policy/*` and all eligibility tests, `estimateTaskCostRatio`,
`handoff.relevantFiles` remains `[]`.

## Deferred

Each needs its own spec.

- **Handoff file lists.** Requires a provenance gate: populate only when
  `isCrossRepository` is false, since a path names a file whose contents an agent will
  open. Charset validation is not a sufficient defense.
- **Size-dependent cost gating eligibility.** Requires calibration data.
- **Calibration.** `reconcile` cannot attribute a delta to a session and `usageRefresh`
  cannot see sessions; both need redesign.
- **Session persistence ordering.** `commands/run.ts` persists after launch, so a schema
  failure orphans a launched agent. Not reachable from this change, because every
  recorded enrichment value is a validated enum or finite integer.
- **`cacheAffinity`.** Computed and stored, never read. Wire it or delete it.
