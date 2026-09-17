# Local Quota + Phase-Sticky Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for every behavior change. Do not deploy, publish, write into an external Hermes checkout, or install/link skills globally.

**Goal:** Make default `router run` honor fresh local quota caches, and make `--session` actually reuse an eligible same-phase route instead of only printing that it does.

**Architecture:** Split collector invocation by kind (`local` vs `full`) in `createDefaultRunDeps`, persist snapshots through the existing `UsageRepository`, add a Codex status-line reader beside Cursor/Claude, and apply `shouldReconsiderRoute` inside `decideRoute` after classification so ranking/effort TypeSafe calls are skipped on sticky reuse.

**Tech Stack:** Node.js 20+, TypeScript, Commander, Zod, Vitest, better-sqlite3, existing TypeSafe port (fake in tests).

**Spec:** `docs/superpowers/specs/2026-09-17-p1-quota-and-phase-sticky-design.md`

## Global Constraints

- Node.js `>=20` (`.nvmrc`).
- Do not deploy Cloudflare coordinator, mutate an external Hermes checkout, or publish packages.
- Do not call live TypeSafe or quota-consuming provider CLIs unless the user explicitly approves in that session.
- TypeSafe still classifies phase; code must not invent phase from the task string.
- Shared 40% reserve and personal-vs-shared unknown-usage rules stay as they are.
- Credentials, cookies, Telegram identifiers, and raw heartbeats never enter TypeSafe state, SQLite payloads beyond existing redaction, or docs/examples.
- Every task's requirements include this section.

## File map

| File                                                                                                                       | Responsibility                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/router/src/commands/runtime.ts`                                                                                  | `usageMode: "local" \| "full"`; filter collectors; persist snapshots                    |
| `packages/router/src/cli.ts`                                                                                               | Default local mode; `--usage` means full chain; wire usage refresh to real collect+save |
| `packages/router/src/commands/usage.ts`                                                                                    | Collect by source, print, optional persist                                              |
| `packages/router/src/collectors/openai/codex-statusline-collector.ts`                                                      | Codex local cache reader                                                                |
| `packages/router/src/collectors/registry.ts`                                                                               | Register Codex local-session                                                            |
| `packages/router/src/semantic/decision-engine.ts`                                                                          | Sticky reuse after classification                                                       |
| `packages/router/src/commands/run.ts`                                                                                      | Pass previous route; honest `cacheDecision`; save `cacheAffinity`                       |
| `packages/router/src/domain/usage.ts`                                                                                      | Comment update: `skipped` is not the default CLI path                                   |
| README, `docs/configuration.md`, `docs/provider-support.md`, `docs/operations.md`, `skills/model-router/references/cli.md` | Document default local quota and real sticky behavior                                   |

---

### Task 1: Local-only usage mode in runtime

**Files:**

- Modify: `packages/router/src/commands/runtime.ts`
- Modify: `packages/router/test/commands/runtime.test.ts`
- Modify: `packages/router/src/cli.ts` (only the `skipUsage: !flags.usage` mapping if needed to keep tests compiling; prefer finishing mapping in Task 4 if Task 1 keeps a temporary alias)

**Interfaces:**

- Consumes: `collectorsForAccount`, `collectUsageChain`, `UsageCollector.kind`
- Produces: `RuntimeOverrides.usageMode?: "local" | "full"` (default `"local"`). When `"local"`, only collectors with `kind === "local-session"` are passed to `collectUsageChain`. When `"full"`, pass the full list. Remove production use of `skipUsage`.

- [ ] **Step 1: Write the failing test**

Replace the `skipUsage: true` test in `packages/router/test/commands/runtime.test.ts` with two tests. Keep `idleCollectors` / `homeWithAccount` / `personal` as in that file.

```ts
it("runs only local-session collectors in default local usage mode", async () => {
  const localCollect = vi.fn(async () => usageFor(personal.id, 0.55));
  const officialCollect = vi.fn(async () => usageFor(personal.id, 0.11));
  const collectors: UsageCollector[] = [
    {
      kind: "official-cli",
      detectAccounts: async () => [],
      collectUsage: officialCollect,
      listAvailableModels: async () => [],
    },
    {
      kind: "local-session",
      detectAccounts: async () => [],
      collectUsage: localCollect,
      listAvailableModels: async () => [],
    },
  ];
  const collectorsForAccount = vi.fn(() => collectors);
  const deps = await createDefaultRunDeps(
    { MODEL_ROUTER_HOME: homeWithAccount() },
    { collectorsForAccount, usageMode: "local" },
  );
  expect(collectorsForAccount).toHaveBeenCalled();
  expect(officialCollect).not.toHaveBeenCalled();
  expect(localCollect).toHaveBeenCalledTimes(1);
  expect(deps.usage[personal.id]?.windows[0]?.remainingRatio).toBe(0.55);
  expect(deps.usage[personal.id]?.source).not.toBe("skipped");
});

it("runs the full collector list when usageMode is full", async () => {
  const officialCollect = vi.fn(async () => usageFor(personal.id, 0.42));
  const collectors: UsageCollector[] = [
    {
      kind: "official-cli",
      detectAccounts: async () => [],
      collectUsage: officialCollect,
      listAvailableModels: async () => [],
    },
  ];
  await createDefaultRunDeps(
    { MODEL_ROUTER_HOME: homeWithAccount() },
    { collectorsForAccount: () => collectors, usageMode: "full" },
  );
  expect(officialCollect).toHaveBeenCalledTimes(1);
});
```

Fix the first test: `createDefaultRunDeps` must still _call_ `collectorsForAccount` (unlike today's `skipUsage` path). Assert `officialCollect` with `expect(officialCollect).not.toHaveBeenCalled()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/router/test/commands/runtime.test.ts`

Expected: FAIL — `skipUsage` still skips `collectorsForAccount`, or `usageMode` is not a valid override.

- [ ] **Step 3: Write minimal implementation**

In `runtime.ts`:

```ts
export interface RuntimeOverrides {
  // ...existing fields except skipUsage
  usageMode?: "local" | "full";
}

function filterCollectors(
  collectors: UsageCollector[],
  usageMode: "local" | "full",
): UsageCollector[] {
  if (usageMode === "full") {
    return collectors;
  }
  return collectors.filter((collector) => collector.kind === "local-session");
}
```

In `createDefaultRunDeps`, `usageMode = overrides.usageMode ?? "local"`. Always call `resolveCollectors(account)`, then `collectUsageChain(account, filterCollectors(..., usageMode))`. Delete `skippedUsage` if nothing else needs source `"skipped"` in production. Keep the `"skipped"` Zod literal so old SQLite rows still parse.

Temporary: if CLI still passes `skipUsage: !flags.usage`, map `skipUsage === true` to `usageMode: "local"` only after tests in this file pass with the new API; Task 4 updates CLI. For this task, if CLI will not compile, map:

```ts
usageMode: (overrides.usageMode ?? (overrides as { skipUsage?: boolean }).skipUsage === false)
  ? "full"
  : "local";
```

Do **not** keep skip-all. Prefer a clean break: update CLI in the same commit if TypeScript fails.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/router/test/commands/runtime.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if the user asked to commit in this session; otherwise leave uncommitted)

```bash
git add packages/router/src/commands/runtime.ts packages/router/test/commands/runtime.test.ts packages/router/src/cli.ts
git commit -m "$(cat <<'EOF'
feat: read local quota caches on every router run

Official CLI and browser collectors stay behind --usage so default routing can exclude empty pools without the slow scrape.
EOF
)"
```

---

### Task 2: Codex status-line collector

**Files:**

- Create: `packages/router/src/collectors/openai/codex-statusline-collector.ts`
- Create: `packages/router/test/collectors/codex-statusline.test.ts`
- Modify: `packages/router/src/collectors/registry.ts`
- Modify: `packages/router/test/collectors/registry.test.ts`

**Interfaces:**

- Consumes: `normalizeUsage`, `UsageCollector`, same 15-minute max-age pattern as `createCursorStatuslineCollector`
- Produces: `createCodexStatuslineCollector(options?: { cachePath?: string; now?: () => number })`, `defaultCodexQuotaCachePath(home?: string)` → `path.join(home, ".codex", "statusline-quota-cache.json")`

- [ ] **Step 1: Write the failing tests**

`packages/router/test/collectors/codex-statusline.test.ts` (mirror `cursor-statusline.test.ts` structure; read that file and match its temp-file style):

```ts
it("parses a fresh weekly_left cache as estimated local-session usage", async () => {
  const cachePath = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(cachePath, JSON.stringify({ weekly_left: 40, at: 1_789_644_000 }));
  const collector = createCodexStatuslineCollector({
    cachePath,
    now: () => 1_789_644_000 * 1000 + 60_000,
  });
  const snapshot = await collector.collectUsage(codexAccount);
  expect(snapshot.certainty).toBe("estimated");
  expect(snapshot.source).toBe("local-session");
  expect(snapshot.windows[0]).toMatchObject({
    kind: "weekly",
    remainingRatio: 0.4,
  });
});

it("returns unknown when the cache is older than 15 minutes", async () => {
  // at is 16 minutes behind now
});
```

In `registry.test.ts`, change the Codex `skips local-session` test to expect `local-session` present:

```ts
expect(collectorsForAccount(account).map((collector) => collector.kind)).toEqual([
  "official-cli",
  "local-session",
  "browser-dashboard",
]);
```

`codexAccount` is `personal` with `agent: "codex"`, `provider: "openai"`, `enabledModels: ["openai:gpt-5.5"]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run packages/router/test/collectors/codex-statusline.test.ts packages/router/test/collectors/registry.test.ts`

Expected: FAIL — module missing; registry still omits local-session for Codex.

- [ ] **Step 3: Write minimal implementation**

Copy `createClaudeStatuslineCollector` / Cursor collector. Zod schema:

```ts
const CacheSchema = z.object({
  weekly_left: z.number(),
  at: z.number().positive(),
});
```

Clamp percent 0–100. `expiresAt` one minute ahead of `now()`, matching Cursor. Stale or invalid file → `certainty: "unknown"`, `source: "local-session"`.

In `registry.ts` `local-session` branch, after Claude, before empty return:

```ts
if (account.agent === "codex") {
  return [createCodexStatuslineCollector({ cachePath: options.codexQuotaCachePath })];
}
```

Add `codexQuotaCachePath?: string` to `CollectorRegistryOptions`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run packages/router/test/collectors/codex-statusline.test.ts packages/router/test/collectors/registry.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (if committing)

```bash
git commit -m "$(cat <<'EOF'
feat: read Codex quota from a local status-line cache

Gives Codex the same fast local-session path Cursor and Claude already have, without calling login status on every run.
EOF
)"
```

---

### Task 3: Persist snapshots and implement `usage refresh`

**Files:**

- Modify: `packages/router/src/commands/usage.ts`
- Create: `packages/router/test/commands/usage.test.ts`
- Modify: `packages/router/src/commands/runtime.ts` (save after collect)
- Modify: `packages/router/src/cli.ts` usage-refresh action
- Modify: `packages/router/src/store/usage-repository.ts` only if a list-all method is needed

**Interfaces:**

- Consumes: `UsageRepository.save`, `collectUsageChain`, `collectorsForAccount`, `loadConfig`
- Produces:

```ts
export async function usageRefresh(input: {
  source: "local-session" | "official-cli" | "browser";
  dryRun: boolean;
  accounts: Account[];
  collect: (account: Account) => Promise<UsageSnapshot>;
  persist?: (snapshot: UsageSnapshot) => void;
}): Promise<string>;
```

Print one line per account: `${account.id} source=${snapshot.source} certainty=${snapshot.certainty} remaining=${ratio ?? "unknown"}`. Redact nothing extra (no task text here). Do not print cache file contents.

- [ ] **Step 1: Write the failing test**

```ts
it("prints local-session facts on dry-run and does not persist", async () => {
  const persist = vi.fn();
  const snapshot = usageFor(personal.id, 0.8, { source: "local-session", certainty: "estimated" });
  const printed = await usageRefresh({
    source: "local-session",
    dryRun: true,
    accounts: [personal],
    collect: async () => snapshot,
    persist,
  });
  expect(printed).toContain(personal.id);
  expect(printed).toContain("estimated");
  expect(persist).not.toHaveBeenCalled();
});

it("persists snapshots when not dry-run", async () => {
  const persist = vi.fn();
  const snapshot = usageFor(personal.id, 0.8, { source: "local-session", certainty: "estimated" });
  await usageRefresh({
    source: "local-session",
    dryRun: false,
    accounts: [personal],
    collect: async () => snapshot,
    persist,
  });
  expect(persist).toHaveBeenCalledWith(snapshot);
});
```

Add a runtime test: after local collect of a known snapshot, `UsageRepository.latest(accountId)` returns it. Open a temp `MODEL_ROUTER_HOME` the same way `runtime.test.ts` does (read `openDatabase` usage in `session.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/router/test/commands/usage.test.ts`

Expected: FAIL — current `usageRefresh` is sync and returns the stub sentence.

- [ ] **Step 3: Write minimal implementation**

Rewrite `usage.ts` as async collect/print/persist. CLI action:

```ts
.action(async (flags: { source?: string; dryRun?: boolean }) => {
  const source = flags.source === "official-cli" || flags.source === "browser"
    ? flags.source
    : "local-session";
  const config = loadConfig({ env });
  const db = openDatabase({ home: config.home });
  try {
    const repo = new UsageRepository(db);
    const printed = await usageRefresh({
      source,
      dryRun: Boolean(flags.dryRun),
      accounts: config.accounts,
      collect: (account) => {
        const collectors = collectorsForAccount(account).filter((collector) =>
          source === "browser"
            ? collector.kind === "browser-dashboard"
            : collector.kind === source,
        );
        return collectUsageChain(account, collectors);
      },
      persist: (snapshot) => {
        repo.save(snapshot);
      },
    });
    stdout.write(`${printed}\n`);
  } finally {
    db.close();
  }
});
```

In `createDefaultRunDeps`, after building `usage`, save each snapshot with `certainty !== "unknown"` through `new UsageRepository(openDatabase(...))`. Close the db in `finally`. If opening a second db is awkward, open once in `createDefaultRunDeps` (it already opens for sessions — read the bottom of `runtime.ts` and reuse that connection if present).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run packages/router/test/commands/usage.test.ts packages/router/test/commands/runtime.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (if committing)

```bash
git commit -m "$(cat <<'EOF'
feat: persist usage snapshots and make usage refresh collect

Default local reads and explicit refresh both write SQLite so status and routing share the same last-known quota.
EOF
)"
```

---

### Task 4: CLI default, `--usage` meaning, docs

**Files:**

- Modify: `packages/router/src/cli.ts`
- Modify: `packages/router/test/cli/run.test.ts` (the test `skips usage by default and collects it only with --usage`)
- Modify: `README.md`, `docs/configuration.md`, `docs/operations.md`, `docs/provider-support.md`, `skills/model-router/references/cli.md`

**Interfaces:**

- Consumes: `usageMode` from Task 1
- Produces: default `usageMode: "local"`; `--usage` → `"full"`

- [ ] **Step 1: Write the failing test**

Update `packages/router/test/cli/run.test.ts` so default `createRunDeps` is called with `usageMode: "local"` (or equivalent), and `--usage` with `usageMode: "full"`. Read the existing test around the "skips usage by default" case and invert the assertion: default still must **not** request full collectors.

```ts
it("uses local usage mode by default and full collectors with --usage", async () => {
  const createRunDeps = vi.fn(async () => runDepsFixture);
  await runCli(["node", "router", "run", "task", "--dry-run"], {
    createRunDeps,
    // ... silent io, env
  });
  await runCli(["node", "router", "run", "task", "--dry-run", "--usage"], {
    createRunDeps,
    // ...
  });
  expect(createRunDeps.mock.calls[0][1]).toMatchObject({ usageMode: "local" });
  expect(createRunDeps.mock.calls[1][1]).toMatchObject({ usageMode: "full" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/router/test/cli/run.test.ts`

Expected: FAIL on old `skipUsage: true` default.

- [ ] **Step 3: Write minimal implementation**

```ts
.option(
  "--usage",
  "Also run official CLI/API and browser quota collectors (slower)",
  false,
)
```

Pass `{ usageMode: flags.usage ? "full" : "local" }`. Same for `router status`: default should collect local-session (so quota numbers show without `--usage` when caches exist). `--usage` on status keeps the full chain. Update `status.test.ts` accordingly: status without `--usage` may now call collect if you wire it; if that is a large behavior change, default status can remain labels-only and only `run` uses local mode. **Spec choice (lock this):** `router status` without `--usage` still prints accounts only; `router status --usage` uses **full** chain as today. Local default applies to `router run` and `router usage refresh`. Do not expand status in this task.

README replacements (edit in place, do not dump the whole README):

- Quota section: usage checks are **local-session by default**; `--usage` adds slow collectors. Shared accounts still need _known_ usage, which a fresh status-line cache now supplies without `--usage`.
- Codex row: document `~/.codex/statusline-quota-cache.json` `{ weekly_left, at }`.
- `router usage refresh` is no longer "dry-run parsing only"; default source is local-session; `--dry-run` does not persist.
- Troubleshooting: picking exhausted Grok without `--usage` should only happen when the cache is missing/stale.

- [ ] **Step 4: Run tests**

Run: `npm test -- --run packages/router/test/cli/run.test.ts packages/router/test/cli/status.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (if committing)

```bash
git commit -m "$(cat <<'EOF'
feat: default router run to local quota caches

Keep --usage as the slow official and browser pass, and document the Codex cache file operators can write.
EOF
)"
```

---

### Task 5: Sticky reuse inside `decideRoute`

**Files:**

- Modify: `packages/router/src/semantic/decision-engine.ts`
- Modify: `packages/router/test/semantic/decision-engine.test.ts`
- Modify: `packages/router/src/sessions/phase-transition.ts` (only if the helper needs `effortSupported`; prefer keeping the helper as-is and computing `routeStillEligible` in `decideRoute`)

**Interfaces:**

- Consumes: `shouldReconsiderRoute`, `SemanticCandidate`
- Produces: extend `DecideRouteInput`:

```ts
previousRoute?: {
  opaqueId: string;
  phase: WorkflowPhase;
  effort: ReasoningEffort;
};
```

Extend selected result with `sticky: boolean` (default false).

- [ ] **Step 1: Write the failing tests**

In `decision-engine.test.ts`, after existing selected-route tests:

```ts
it("reuses the previous eligible route in the same phase without ranking", async () => {
  const client = fakeTypeSafe({
    family: "implementation",
    phase: "implementation",
    route: "acct:other",
    effort: "high",
  });
  const decision = await decideRoute({
    task: "Keep implementing the plan.",
    userRequestedUltra: false,
    client,
    candidates: [
      {
        opaqueId: "acct:cursor:grok-4.6",
        agent: "cursor",
        modelId: "cursor:grok-4.6",
        supportedEfforts: ["low", "medium", "high"],
        projectedRemainingRatio: 0.8,
        capabilities: cursorModel.capabilities,
      },
    ],
    previousRoute: {
      opaqueId: "acct:cursor:grok-4.6",
      phase: "implementation",
      effort: "medium",
    },
  });
  expect(decision).toMatchObject({
    status: "selected",
    candidateOpaqueId: "acct:cursor:grok-4.6",
    effort: "medium",
    sticky: true,
  });
  expect(client.calls.some((call) => "route" in call.questions)).toBe(false);
  expect(client.calls.some((call) => "effort" in call.questions)).toBe(false);
});

it("re-ranks at a phase boundary even if the previous route is still eligible", async () => {
  const client = fakeTypeSafe({
    family: "implementation",
    phase: "implementation",
    route: "acct:cursor:grok-4.6",
    effort: "low",
  });
  const decision = await decideRoute({
    task: "Implement the approved plan.",
    userRequestedUltra: false,
    client,
    candidates: [/* same as above */],
    previousRoute: {
      opaqueId: "acct:cursor:grok-4.6",
      phase: "planning",
      effort: "high",
    },
  });
  expect(decision).toMatchObject({
    status: "selected",
    effort: "low",
    sticky: false,
  });
  expect(client.calls.some((call) => "route" in call.questions)).toBe(true);
});
```

Use the real `SemanticCandidate` shape from `packages/router/src/semantic/candidate.ts` (read it; include every required field). Add a third test: previous opaque id not in candidates → ranking happens.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run packages/router/test/semantic/decision-engine.test.ts`

Expected: FAIL — ranking always runs; no `sticky` field.

- [ ] **Step 3: Write minimal implementation**

After successful classification in `decideRoute`:

```ts
import { shouldReconsiderRoute } from "../sessions/phase-transition.js";

const previous = input.previousRoute;
const previousCandidate = previous
  ? input.candidates.find((candidate) => candidate.opaqueId === previous.opaqueId)
  : undefined;
const routeStillEligible = Boolean(previousCandidate?.supportedEfforts.includes(previous!.effort));
if (
  previous &&
  !shouldReconsiderRoute({
    currentPhase: previous.phase,
    nextPhase: phase,
    routeStillEligible,
  })
) {
  return {
    status: "selected",
    candidateOpaqueId: previous.opaqueId,
    effort: previous.effort,
    phase,
    family,
    confidence: 1,
    reason: `reused previous route ${previous.opaqueId} (same phase)`,
    sticky: true,
  };
}
```

Set `sticky: false` on the normal selected return. Classification catch path unchanged (no sticky without phase).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run packages/router/test/semantic/decision-engine.test.ts packages/router/test/sessions/phase-transition.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (if committing)

```bash
git commit -m "$(cat <<'EOF'
feat: skip TypeSafe ranking when a same-phase route is still eligible

Phase boundaries still re-rank; in-phase --session reuse keeps model and effort stable.
EOF
)"
```

---

### Task 6: Wire sticky resume through `executeRun` and the decision card

**Files:**

- Modify: `packages/router/src/commands/run.ts`
- Modify: `packages/router/src/presentation/decision-card.ts` (only if `cacheDecision` needs no change; it is already a string)
- Modify: `packages/router/test/cli/session.test.ts`
- Modify: `packages/router/test/cli/run.test.ts` (card text for no previous session)

**Interfaces:**

- Consumes: `previous.route`, `decideRoute` `sticky` flag, `cacheAffinityKey`
- Produces: honest `cacheDecision` strings from the spec; `session.cacheAffinity` populated on save

- [ ] **Step 1: Write the failing tests**

In `session.test.ts`, after the planning→implementation link test, add:

```ts
it("reuses the previous route when the next task stays in the same phase", async () => {
  const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
  const first = await executeRun("Implement the billing repository.", { dryRun: false }, deps);
  const firstId = (first.json as { sessionId: string }).sessionId;
  deps.sessions.save({ ...deps.sessions.get(firstId)!, phase: "implementation" });
  const second = await executeRun(
    "Continue implementing the billing repository.",
    { dryRun: false, previousSessionId: firstId },
    deps,
  );
  expect(second.code).toBe(0);
  expect(second.output).toMatch(/Cache decision: reused previous route \(same phase\)/);
  expect(second.json).toMatchObject({
    selected: `${personal.id}:${cursorModel.id}`,
    effort: "medium",
  });
  const rankingCalls = (deps.client.calls as { questions: object }[]).filter(
    (call) => "route" in call.questions,
  );
  expect(rankingCalls).toHaveLength(1); // only the first launch ranked
  db.close();
});
```

Read `runDeps` in that file: if `fakeTypeSafe` always returns implementation, both launches classify implementation and the second must skip ranking. If the helper always ranks today, `rankingCalls` length is 2 — that is the failure.

Add/adjust the first dry-run card test in `run.test.ts`:

```ts
expect(result.output).toMatch(/Cache decision: no previous session/);
```

Phase-boundary test already expects `planning -> implementation`; add:

```ts
expect(result.output).toMatch(/Cache decision: phase change justifies a structured handoff/);
```

When saving a session in `executeRun`, set:

```ts
cacheAffinity: {
  provider: selected.account.provider,
  modelId: selected.model.id,
  effort: decision.effort,
  agent: selected.model.agent,
  promptPrefixHash: cacheAffinityKey({
    provider: selected.account.provider,
    modelId: selected.model.id,
    effort: decision.effort,
    agent: selected.model.agent,
    promptPrefix: task.slice(0, 80),
  }).split(":").at(-1)!,
}
```

`cacheAffinityKey` already returns a joined string whose last segment is the prefix hash. Prefer:

```ts
const key = cacheAffinityKey({ ... });
cacheAffinity: {
  provider: selected.account.provider,
  modelId: selected.model.id,
  effort: decision.effort,
  agent: selected.model.agent,
  promptPrefixHash: key.slice(key.lastIndexOf(":") + 1),
}
```

Pass into `decideRoute`:

```ts
previousRoute: previous?.route
  ? {
      opaqueId: `${previous.route.accountId}:${previous.route.modelId}`,
      phase: previous.phase,
      effort: previous.route.effort,
    }
  : undefined,
```

Card `cacheDecision`:

```ts
decision.sticky
  ? "reused previous route (same phase)"
  : previous
    ? previous.phase !== decision.phase
      ? "phase change justifies a structured handoff"
      : "previous route ineligible; re-ranked"
    : "no previous session",
```

`RouteDecisionResult` selected branch must include `sticky: boolean` or `executeRun` cannot branch. If TypeScript complains, add `sticky` in Task 5.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run packages/router/test/cli/session.test.ts packages/router/test/cli/run.test.ts`

Expected: FAIL — card still says `phase sticky unless eligibility changes`.

- [ ] **Step 3: Write minimal implementation** in `executeRun` as specified above. Do not skip `revalidateDecision` on sticky reuse.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run packages/router/test/cli/session.test.ts packages/router/test/cli/run.test.ts packages/router/test/e2e/router-dry-run.test.ts`

Expected: PASS. Update e2e fixtures if they snapshot the old cache line.

- [ ] **Step 5: Commit** (if committing)

```bash
git commit -m "$(cat <<'EOF'
feat: honor phase-sticky routing on session resume

Same-phase launches reuse the eligible model and effort; the decision card reports reuse, phase change, or ineligibility.
EOF
)"
```

---

### Task 7: Verify and record

**Files:**

- Modify: `docs/validation/2026-09-17-live-smoke.md` only if you run new dry-runs (append a dated subsection; do not claim live provider calls)

**Interfaces:** none new

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`

Expected: typecheck, lint, format, tests, build all pass.

- [ ] **Step 2: Dry-run CLI locally without live TypeSafe if the key is absent**

Run: `router run "Implement the approved plan in docs/superpowers/plans/2026-09-17-p1-quota-and-phase-sticky.md" --dry-run`

Expected: either a decision card with `Cache decision: no previous session` and a local usage source, or `typesafe-unavailable` (acceptable without a key). Must **not** print `phase sticky unless eligibility changes`. Must **not** create a Herdr pane.

- [ ] **Step 3: Do not deploy**

Do not `wrangler deploy`, do not `npm publish`, do not write Hermes checkouts.

- [ ] **Step 4: Commit docs** (if committing)

```bash
git commit -m "$(cat <<'EOF'
docs: describe default local quota and phase-sticky resume

EOF
)"
```

---

## Self-review

1. **Spec coverage:** P1-A local default → Tasks 1, 4. Codex cache → Task 2. Persist + refresh → Task 3. Status unchanged without `--usage` → Task 4 lock. P1-B decideRoute → Task 5. Card + session + cacheAffinity → Task 6. Verify → Task 7. TypeSafe outage / `--choose` / deploy explicitly out of scope.
2. **Placeholders:** none; commands, types, and test bodies are spelled out.
3. **Types:** `usageMode` is `"local" | "full"` everywhere. `previousRoute.opaqueId` is `` `${accountId}:${modelId}` `` matching `executeRun`. `sticky` is on the selected decision only.

## Out of scope (do not implement in this plan)

- `deterministicFallback` wiring when TypeSafe is down
- `--choose` after exit 3
- Native Herdr plugin, coordinator deploy, Hermes checkout
- Task-length cost estimator, richer handoff file lists
