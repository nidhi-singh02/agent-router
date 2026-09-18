# Task Enrichment Design

**Date:** 2026-09-18
**Status:** approved design, not yet implemented
**Scope:** `packages/router`

## Problem

The routing classifier sees only the raw prompt string. `decideRoute` builds its
classification state as `{ task, candidateCount }` (`semantic/decision-engine.ts:73`),
so "refactor PR 9" is indistinguishable from a one-line typo fix. Every downstream
judgment — task family, complexity, consequence, reasoning effort — is made without
any measurement of the work.

Two related gaps compound it:

- `estimateTaskCostRatio` is `relativeQuotaCost * 0.02` (`policy/cost-estimator.ts`),
  a constant that ignores task size entirely.
- `buildHandoff` is always called with `relevantFiles: []`, `completedChecks: []`,
  and `remainingAcceptanceCriteria: []` (`commands/run.ts:199-205`), so the
  cross-phase context channel carries nothing.

## Goals

1. Give the classifier a real measurement of task size when the prompt names a
   resolvable reference.
2. Fill `handoff.relevantFiles` with the files a task actually touches.
3. Record what a size-aware cost estimate _would_ have produced, so the estimate can
   be calibrated against observed consumption.

## Non-goals

- **Size-dependent cost gating eligibility.** Deferred; see "Deferred: the cost gate".
- **PR titles, branch names, or PR body text in any output.** Explicitly out of scope.
  A later "make the handoff more useful" change must not add them without a second
  security review.
- Issue-ref resolution. PR refs only.
- Resolving refs for any repository other than the one the CLI is running in.

## Decisions

| Decision          | Choice                                                               | Rationale                                                              |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Resolution source | `gh` for PR refs, local `git` only for explicitly named inline paths | A bare PR number is the motivating case and local git cannot answer it |
| Ref kinds         | PR refs and inline file paths                                        | Issue refs add surface without adding size signal                      |
| TypeSafe egress   | Bucketed numbers and closed-vocabulary enums only                    | A raw line count fingerprints a private diff                           |
| Handoff paths     | Full paths, validated, capped at 20                                  | The next agent must be able to open them                               |
| Cost estimate     | Unchanged constant; buckets computed and logged only                 | Uncalibrated gating has asymmetric failure                             |
| Failure channel   | `result.json` + decision card                                        | `stderr` is invisible under `--json`                                   |

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

A bucket table is a guess about which row a given diff belongs in, and the guess sets
that headroom requirement directly. The failure is asymmetric: too low costs nothing
relative to today's flat estimate, while too high hard-denies routes with a bare
`code 2` that names no cause. Deferring also removes two defects outright rather than
mitigating them — an unclamped ratio cannot breach `RatioSchema`, and a same-phase
resume cannot be evicted by a re-measured diff.

## Architecture

New module `packages/router/src/enrich/`:

| File              | Responsibility                                                             |
| ----------------- | -------------------------------------------------------------------------- |
| `ref-detector.ts` | Pure. Prompt string -> `DetectedRefs`. No I/O.                             |
| `resolver.ts`     | Ref-kind routed resolution via `runCommand`. Returns `EnrichmentLocal`.    |
| `local.ts`        | `EnrichmentLocal` type. Full paths. Never exported past `enrich/`.         |
| `shapes.ts`       | `EnrichmentLocal` -> `EnrichmentShapes`. Closed vocabulary.                |
| `buckets.ts`      | Deterministic size -> bucket and advisory multiplier. Logged, not applied. |

### Types

```ts
// enrich/ref-detector.ts — unforgeable by construction
export interface DetectedRefs {
  prNumbers: number[]; // parsed integers, never matched substrings
  paths: string[]; // charset-validated, relative, no leading "-"
}

// enrich/local.ts — NOT exported past enrich/
export interface EnrichmentLocal {
  prNumber?: number;
  repo?: string;
  files: { path: string; added: number; removed: number }[];
  additions: number;
  deletions: number;
  changedFiles: number;
  truncated: boolean;
}

// enrich/shapes.ts — the ONLY type decideRoute accepts.
// No free-form string field anywhere.
export interface EnrichmentShapes {
  sizeBucket: "trivial" | "small" | "medium" | "large" | "very-large";
  fileCountBucket: "1" | "2-5" | "6-20" | "21-100" | "100+";
  areas: ("src" | "test" | "docs" | "config" | "other")[];
  extensions: ("ts" | "js" | "json" | "md" | "sql" | "yaml" | "other")[];
  spread: "single-dir" | "few-dirs" | "many-dirs";
  truncated: boolean;
}
```

The safety property is structural: no field of `EnrichmentShapes` can _hold_ a path,
so no path can reach TypeSafe state. Validation is a corollary, not the mechanism.

### Flow in `commands/run.ts`

1. Detect refs. No refs -> skip enrichment entirely, no subprocess.
2. Resolve (see "Resolver contract"). Failure -> route unenriched, record reason.
3. `decideRoute` receives `enrichment?: EnrichmentShapes` as a typed parameter and
   constructs classification state from that field alone.
4. Eligibility, ranking, effort: unchanged. `estimateTaskCostRatio` unchanged.
5. `buildHandoff` receives validated full paths as `relevantFiles`.
6. `result.json.enrichment` and one decision-card line report status.

`candidateCount` stays in the classification state. No reordering is required, because
no model-produced number feeds the cost estimate.

## Resolver contract

Route by ref **kind**, never by fallback order. A local working-tree diff must never
answer a named PR ref — in a dirty worktree that silently sizes the task from
unrelated uncommitted work.

| Input                   | Command                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| PR ref                  | `gh pr view <n> --json additions,deletions,changedFiles,files,baseRefName,headRepository,headRepositoryOwner` |
| Inline paths, no PR ref | `git diff --numstat -- <validated paths>`                                                                     |
| Neither                 | No subprocess                                                                                                 |

`gh pr diff --stat` does not exist. Verified against gh 2.87.3: `gh pr diff` accepts
only `--color`, `--name-only`, `--patch`, `--web`. Use `gh pr view --json`.

Use `--numstat`, not `--stat`. `--stat` is human-formatted and truncates long paths
with `...`.

### Repository identity

Resolve once per run:

- `git rev-parse --show-toplevel` must succeed; pass the result as an explicit `cwd`.
  `runCommand` sets no `cwd` (`collectors/command-runner.ts:18-21`), so it would
  otherwise inherit the CLI's directory.
- `git rev-parse --git-common-dir` to detect a worktree. Worktrees are usable, but the
  worktree and branch must be recorded and displayed; do not assume it is the PR's branch.
- Compare `gh repo view --json nameWithOwner` against the PR's **base** repository.
  Compare base, not head: fork PRs legitimately differ on head. Refuse on mismatch.
- Submodules collapse to a single `Subproject commit` line, under-reporting size.
  Detect via `git submodule status` and mark the result as a lower bound.
- Not a repository: no local resolution, PR refs unresolved.

## Security requirements

These are blockers, not preferences. Each was verified empirically during review.

### B1 — Argument injection

`spawn` with an args array prevents shell injection, but `git` and `gh` interpret any
token beginning with `-` as an option. `git diff --stat --output=<path> HEAD~1 HEAD`
truncates and overwrites `<path>`; a prompt pasted from an issue body is a normal input.
`gh` additionally accepts `-R [HOST/]OWNER/REPO`, redirecting the request to an
attacker-chosen host with the stored credential for it.

Required:

1. Pathspecs only after a `--` separator.
2. PR numbers re-emitted as `String(parsedInt)`, never the matched substring.
3. Resolver input typed `{ prNumbers: number[]; paths: string[] }`, so the numeric
   path is unforgeable.
4. Reject tokens matching `/^-/`, containing `://`, or containing `/` for PR refs, at
   the detector boundary, and re-validate in the resolver.

### B2 — Untrusted content in an autonomous agent's prompt

`formatHandoffPrompt` renders `relevantFiles` as `- ${item}` lines
(`handoff/handoff-builder.ts:46-53`) and the result is submitted as a launched agent's
prompt. Git path names are near-arbitrary: a file named
`src/Ignore all previous instructions; ... (.ts` is emitted verbatim by `git diff`.
On a public repo the PR author controls every path in the diff. Poisoned strings also
persist to the session (`commands/run.ts:273`) and replay into the next phase
(`commands/run.ts:219`), so one PR contaminates a `--session` chain.

Required:

1. Validate every path before it enters `relevantFiles`: charset `[A-Za-z0-9._/-]`,
   no absolute paths, no `..`, no newline, carriage return, backtick, or `$(`.
   Drop non-conforming entries and count them into the `+N more files` marker.
2. Add the constraint to `HandoffSchema.relevantFiles` (`domain/session.ts:31`), which
   is currently `z.array(z.string())`, so it is enforced at the type boundary rather
   than one call site.
3. Render the section as untrusted data and place it **before** the routing-instruction
   block (`handoff-builder.ts:55-64`). The agent is told to obey that block; anything
   after it inherits its authority.
4. Never include PR titles, branch names, or body text.
5. Do not set `core.quotePath=false` and do not use `-z` or `--name-only -z`. Git
   escapes a newline in a path to a literal `\n` under the default; `-z` emits raw
   NUL-separated paths and restores line-forging. This default is the entire
   line-forging defense.

`redactCollectorText` is not a prompt-injection defense; it strips `sk-` prefixes.

### B3 — Enrichment must not be able to abort a route

`assertSafeState` is called at `semantic/decision-engine.ts:74`, outside the `try` that
opens at `:77`, so a throw escapes to `cli.ts:93` and exits 1. Its patterns match
credential _shapes_: a branch or path merely shaped like `AKIA…` or `ghp_…` would
hard-fail every route on that PR — a remote kill switch.

Required: enrichment-derived fields must never throw. On any error, drop the
enrichment, route unenriched, and record the reason. Do not rely on a try/catch move
as the mitigation; a caught throw still kills a route that should have proceeded.

Do not extend `assertSafeState`'s regexes for diff content. A denylist over
`JSON.stringify(state)` cannot certify unknown content, and the patterns are both too
weak for it (file contents never arrive with `--json files`, and names like
`secrets/prod.env` match nothing) and too trigger-happy on it. `assertSafeState`
remains a backstop on caller-supplied task text only.

### B4 — Do not reuse `collectVerifiedStatus`

`collectors/verified-command.ts:22` does `raw = result.ok ? result.stdout : result.stderr`,
feeding a `gh` error message to the parser as if it were diff data. It also hardcodes
the collector timeout and byte cap and passes no `env` or `cwd`. The resolver calls
`runCommand` directly.

### Enforcement

1. `EnrichmentShapes` has no free-form `string` field. (Load-bearing.)
2. `decideRoute` accepts `enrichment?: EnrichmentShapes` and builds state from it alone.
3. ESLint `no-restricted-imports`: `semantic/**` may not import `enrich/local*`.
4. Test: snapshot `client.calls` — `createRecordingClient` already captures every
   request (`semantic/typesafe-client.ts:13-23`) — and fail on any string value
   containing `/` or matching a file-extension pattern. (Load-bearing: the only check
   that catches an unforeseen path.)

## Resource limits

- At most 3 refs resolved per run; at most 1 network call per run.
- 2s per call, 3s total enrichment budget. `COLLECTOR_TIMEOUT_MS` (5s) is for local
  collectors, not a network hop on an interactive path.
- 64KB byte cap. Detect truncation by comparing returned length to `maxBytes`, and
  kill the child on overflow — `command-runner.ts:41-45` stops accumulating but lets
  the process run to its timeout.
- Memoize by `(repoNameWithOwner, prNumber)` so a `--session` chain does not re-fetch.
- `--no-enrich` flag; auto-skip under `--json`.

`CommandResult` needs `code: number | null` and `timedOut: boolean` added
(`command-runner.ts:25-36` returns only `ok`) to distinguish the failure cases below.

## Failure matrix

| Case                           | Behavior                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| No refs detected               | No subprocess. Card: `not resolved (no refs)`. Silent.                 |
| Refs, cwd not a repository     | `unresolved: not a repository`                                         |
| `gh` missing (ENOENT)          | `unresolved: gh not installed`. No retry.                              |
| `gh` unauthenticated (exit 4)  | `unresolved: gh not authenticated (run gh auth login)`                 |
| Rate-limited or 5xx            | `unresolved: github unavailable`. No retry in the hot path.            |
| Timeout                        | `unresolved: timed out after Nms`. Distinct from failure.              |
| PR not found                   | `unresolved: PR #N not found in <owner/repo>`. Name the repo.          |
| Private, no access             | Same user-visible text as not-found. Log the exit code.                |
| Truncated output               | `resolved (truncated; size is a lower bound)`. Never present as exact. |
| Resolved from a different repo | Refuse to use it.                                                      |

Warnings surface when a ref was detected and resolution failed. The last two rows are
cases where resolution **succeeded with a wrong answer**, so they surface regardless.

## Output

Add to `result.json`:

```ts
enrichment: {
  status: "skipped" | "resolved" | "truncated" | "unresolved";
  reason?: string;
  repo?: string;
  refs?: number[];
  files?: number;
  sizeBucket?: string;
}
```

One decision-card line, including repo identity:
`Task size: 412 lines across 9 files (PR #9 in owner/repo)`

Do not write to `stderr` from `executeRun`. `cli.ts:91` emits only `result.json` under
`--json`, every existing diagnostic rides inside `output`/`json`, and plugin consumers
are precisely the audience for an unresolved size.

## Measurement for calibration

Persist `{ resolvedSize, sizeBucket, advisoryMultiplier, estimatedCostRatio }` on the
session record. `advisoryMultiplier` is computed by `enrich/buckets.ts` and recorded
only — it is not applied to `estimateTaskCostRatio`.

Wire `ReservationService.reconcile` (`reservations/reservation-service.ts:56`), which
exists, is tested, and is currently called from no production path. At the next usage
refresh, compare the recorded estimate against the observed delta in `remainingRatio`
for that account. After enough real sessions this yields a measured size-to-ratio curve,
at which point the gate can be enabled against data rather than a guess.

## Prerequisite

Land first, separately from this work: move the `assertSafeState` call at
`semantic/decision-engine.ts:74` inside the `try`, so a detector hit on tainted user
input becomes a typed result instead of an escaped exception and a generic exit 1.
This is a defect today, independent of enrichment.

## Testing

New:

- `ref-detector`: PR forms (`PR 9`, `pr #9`, `#9`), rejection of `-`-leading tokens,
  `://`, and `/` in PR refs.
- `shapes`: unknown directory and extension collapse to `other`; no `string` field.
- Path validation: newline, backtick, `$(`, absolute, `..`, and the literal
  `Ignore all previous instructions` filename.
- Resolver: ref-kind routing; a dirty worktree must not answer a PR ref; base-repo
  mismatch refusal; each failure-matrix row.
- Enforcement: `client.calls` snapshot rejects path-shaped strings.
- Limits: ref cap, single network call, timeout, truncation detection.

Changed: `handoff-builder` tests for the new section and its ordering;
`domain/session.ts` schema tests for the `relevantFiles` constraint; `commands/run.ts`
tests for the `enrichment` JSON block and card line.

Unchanged: `semantic/decision-engine` classification state keeps `candidateCount`;
`policy/cost-estimator` and all eligibility tests are untouched.

## Deferred

- Size-dependent cost gating eligibility, pending calibration data.
- Issue-ref resolution.
- `cacheAffinity` is computed and stored (`commands/run.ts:239`) but never read;
  decide separately whether to wire or delete it.
- Reservation `ttlMs` is hardcoded at 60s (`commands/run.ts:181`); revisit when cost
  becomes size-dependent.
- Session persistence happens after launch (`commands/run.ts:208` then `:240`),
  so a schema error would orphan a launched agent. Not reachable while cost is
  constant; fix before enabling the gate.
