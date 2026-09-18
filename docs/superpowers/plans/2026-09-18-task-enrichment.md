# Task Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a prompt names a pull request in this repository, measure that PR's size and give the routing classifier a bucketed summary of it.

**Architecture:** A new `packages/router/src/enrich/` module detects `PR <n>` references in the task string, resolves the first one through a single `gh pr view --json` call, and converts the result into three scalar fields. Those fields reach the TypeSafe classification and effort calls as a typed parameter, and appear on the decision card and in `result.json`. Nothing derived from the PR reaches the handoff, the cost estimate, or a launched agent's prompt.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod 4, Vitest, Commander, `gh` CLI 2.87+.

**Spec:** `docs/superpowers/specs/2026-09-18-task-enrichment-design.md`

## Global Constraints

- All imports use `.js` extensions, matching the existing codebase (ESM).
- Tests are Vitest, under `packages/router/test/<area>/<name>.test.ts`.
- Subprocesses run only through `runCommand` (`collectors/command-runner.ts`), never `collectVerifiedStatus`, which feeds stderr to its parser as data (`collectors/verified-command.ts:22`).
- No file path from any source may enter TypeSafe state, the decision card, `result.json`, the session record, or a launched agent's prompt.
- `enrichment.reason` is always a value from the `UnresolvedReason` union. Never subprocess stdout or stderr — launched agents read this CLI's output.
- `estimateTaskCostRatio` (`policy/cost-estimator.ts`) is not modified by this plan.
- `handoff.relevantFiles` stays `[]`.
- Every numeric value derived from a subprocess is checked with `Number.isFinite` before use.
- Run the suite with `(cd packages/router && npx vitest run)`.

---

### Task 1: Distinct `unsafe-state` status (prerequisite)

`assertSafeState` throws at `semantic/decision-engine.ts:74`, outside the `try` at `:77`, so a credential-shaped prompt exits 1 with a generic error. Moving the call inside the existing `try` is wrong: it would return `typesafe-unavailable`, which makes `run.ts` print "TypeSafe could not select a route" plus `typesafeKeyHint` — telling a user to store an API key because their prompt looked like a token.

**Files:**

- Modify: `packages/router/src/semantic/decision-engine.ts`
- Modify: `packages/router/src/commands/run.ts`
- Test: `packages/router/test/semantic/decision-engine.test.ts`

**Interfaces:**

- Produces: `RouteDecisionResult` gains the variant `{ status: "unsafe-state" }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/semantic/decision-engine.test.ts`, reusing whatever local helpers the surrounding tests already use to build a client and a candidate:

```ts
it("returns unsafe-state instead of throwing when the task contains a credential shape", async () => {
  const result = await decideRoute({
    task: "refactor using key AKIAIOSFODNN7EXAMPLE now",
    candidates: [candidate("acct:model")],
    userRequestedUltra: false,
    client: scriptedClient({}),
  });
  expect(result.status).toBe("unsafe-state");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/semantic/decision-engine.test.ts -t "unsafe-state")`
Expected: FAIL — the call throws `TypeSafe state contains forbidden sensitive data` rather than returning.

- [ ] **Step 3: Write minimal implementation**

In `packages/router/src/semantic/decision-engine.ts`, add the variant to the `RouteDecisionResult` union:

```ts
  | { status: "unsafe-state" }
```

Replace the bare call at line 74:

```ts
const classificationState = { task: input.task, candidateCount: input.candidates.length };
try {
  assertSafeState(classificationState);
} catch {
  return { status: "unsafe-state" };
}
```

Apply the same wrapping to the `assertSafeState(rankingState)` call later in the function.

- [ ] **Step 4: Add the caller message**

In `packages/router/src/commands/run.ts`, before the existing `decision.status !== "selected"` branch:

```ts
if (decision.status === "unsafe-state") {
  const output =
    "Task text looks like it contains a credential and was not sent. Remove the secret and retry.";
  return { code: 2, output, json: { ok: false, status: "unsafe-state" } };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `(cd packages/router && npx vitest run)`
Expected: PASS, including existing tests.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/semantic/decision-engine.ts packages/router/src/commands/run.ts packages/router/test/semantic/decision-engine.test.ts
git commit -m "fix: report credential-shaped task text as a distinct status"
```

---

### Task 2: `runCommand` gains `cwd`, `code`, `timedOut`, and a `RunDeps` seam

**Files:**

- Modify: `packages/router/src/collectors/command-runner.ts`
- Modify: `packages/router/src/commands/run.ts` (the `RunDeps` interface)
- Modify: `packages/router/src/commands/runtime.ts` (thread `overrides.runCommand` into `RunDeps`)
- Test: `packages/router/test/collectors/command-runner.test.ts` (create)

**Interfaces:**

- Produces: `runCommand` input accepts `cwd?: string`. `CommandResult` gains `code: number | null` and `timedOut: boolean`. `RunDeps` gains `runCommand?: typeof runCommand`.

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/collectors/command-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/collectors/command-runner.js";

describe("runCommand", () => {
  it("reports the exit code and that it did not time out", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "process.exit(3)"],
      timeoutMs: 2_000,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("runs in the requested cwd", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      timeoutMs: 2_000,
      maxBytes: 4096,
      cwd: "/tmp",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("tmp");
  });

  it("flags a timeout", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 150,
      maxBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/collectors/command-runner.test.ts)`
Expected: FAIL — `code` and `timedOut` are not properties of `CommandResult`; `cwd` is not accepted.

- [ ] **Step 3: Write minimal implementation**

In `packages/router/src/collectors/command-runner.ts`:

```ts
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  executedReturnedOutput: false;
}

export async function runCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CommandResult> {
```

Pass `cwd` to `spawn`:

```ts
const child = spawn(input.command, input.args, {
  env: input.env ?? process.env,
  cwd: input.cwd,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Track the timeout and code:

```ts
let timedOut = false;
const finish = (ok: boolean, code: number | null) => {
  if (settled) {
    return;
  }
  settled = true;
  resolve({
    ok,
    stdout: stdout.slice(0, input.maxBytes),
    stderr: stderr.slice(0, input.maxBytes),
    code,
    timedOut,
    executedReturnedOutput: false,
  });
};
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
  finish(false, null);
}, input.timeoutMs);
```

`child.on("error", ...)` calls `finish(false, null)`; `child.on("close", (code) => { clearTimeout(timer); finish(code === 0, code); })`.

Do **not** change the byte-overflow behavior. Collectors currently truncate and return `ok: true`; killing the child on overflow would regress them.

- [ ] **Step 4: Add the `RunDeps` seam**

In `packages/router/src/commands/run.ts`, add to the `RunDeps` interface:

```ts
  /** Subprocess runner, injected for tests. */
  runCommand?: typeof runCommand;
```

with `import type { runCommand } from "../collectors/command-runner.js";` at the top.

In `packages/router/src/commands/runtime.ts`, inside `createDefaultRunDeps`'s returned object, add:

```ts
    runCommand: overrides.runCommand,
```

- [ ] **Step 5: Run the full suite**

Run: `(cd packages/router && npx vitest run)`
Expected: PASS. Existing collector tests construct `CommandResult` literals; add `code: 0, timedOut: false` to any that fail to typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/collectors/command-runner.ts packages/router/src/commands/run.ts packages/router/src/commands/runtime.ts packages/router/test/collectors/command-runner.test.ts
git commit -m "feat: let runCommand report exit code, timeout, and working directory"
```

---

### Task 3: PR reference detection

**Files:**

- Create: `packages/router/src/enrich/ref-detector.ts`
- Test: `packages/router/test/enrich/ref-detector.test.ts`

**Interfaces:**

- Produces: `detectPrRefs(task: string): number[]` — parsed integers, deduplicated, in order of appearance.

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/enrich/ref-detector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectPrRefs } from "../../src/enrich/ref-detector.js";

describe("detectPrRefs", () => {
  it("detects the explicit PR forms", () => {
    expect(detectPrRefs("refactor PR 9")).toEqual([9]);
    expect(detectPrRefs("refactor pr #9")).toEqual([9]);
    expect(detectPrRefs("refactor PR#9")).toEqual([9]);
    expect(detectPrRefs("look at pr 1234567")).toEqual([1234567]);
  });

  it("ignores a bare issue reference", () => {
    expect(detectPrRefs("fixes #9")).toEqual([]);
    expect(detectPrRefs("see #9 and #10")).toEqual([]);
  });

  it("returns refs in order, deduplicated", () => {
    expect(detectPrRefs("compare PR 10 with PR 9 and PR 10 again")).toEqual([10, 9]);
  });

  it("rejects values outside the integer bound", () => {
    expect(detectPrRefs("PR 12345678")).toEqual([]);
    expect(detectPrRefs("PR 0")).toEqual([]);
  });

  it("does not match inside a longer word", () => {
    expect(detectPrRefs("SUPR 9")).toEqual([]);
    expect(detectPrRefs("PRE 9")).toEqual([]);
  });

  it("returns an empty array for text with no reference", () => {
    expect(detectPrRefs("add a dark mode toggle")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/enrich/ref-detector.test.ts)`
Expected: FAIL — cannot resolve `../../src/enrich/ref-detector.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/router/src/enrich/ref-detector.ts`:

```ts
/** Largest PR number accepted; keeps prompt-derived values well inside safe integers. */
const MAX_PR_NUMBER = 9_999_999;

/**
 * Detects explicit pull request references in a task string.
 *
 * Only the explicit forms are accepted (`PR 9`, `pr #9`, `PR#9`). A bare `#9` is the
 * canonical issue reference, and matching it would fire an authenticated network
 * request on a prompt pasted from a chat message or an issue body.
 */
export function detectPrRefs(task: string): number[] {
  const pattern = /(?:^|[^A-Za-z0-9])(?:PR|pr|Pr)\s*#?\s*(\d{1,8})(?![0-9])/g;
  const found: number[] = [];
  for (const match of task.matchAll(pattern)) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PR_NUMBER) {
      continue;
    }
    if (!found.includes(parsed)) {
      found.push(parsed);
    }
  }
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/router && npx vitest run test/enrich/ref-detector.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/enrich/ref-detector.ts packages/router/test/enrich/ref-detector.test.ts
git commit -m "feat: detect explicit pull request references in a task string"
```

---

### Task 4: Size buckets

**Files:**

- Create: `packages/router/src/enrich/buckets.ts`
- Test: `packages/router/test/enrich/buckets.test.ts`

**Interfaces:**

- Produces: `EnrichmentShapes`; `toShapes(input: { churn: number; changedFiles: number }): EnrichmentShapes`; `advisoryMultiplier(bucket: EnrichmentShapes["sizeBucket"]): number`.

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/enrich/buckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { advisoryMultiplier, toShapes } from "../../src/enrich/buckets.js";

describe("toShapes", () => {
  it("maps churn to size buckets at the boundaries", () => {
    expect(toShapes({ churn: 9, changedFiles: 1 }).sizeBucket).toBe("trivial");
    expect(toShapes({ churn: 10, changedFiles: 1 }).sizeBucket).toBe("small");
    expect(toShapes({ churn: 49, changedFiles: 1 }).sizeBucket).toBe("small");
    expect(toShapes({ churn: 50, changedFiles: 1 }).sizeBucket).toBe("medium");
    expect(toShapes({ churn: 249, changedFiles: 1 }).sizeBucket).toBe("medium");
    expect(toShapes({ churn: 250, changedFiles: 1 }).sizeBucket).toBe("large");
    expect(toShapes({ churn: 999, changedFiles: 1 }).sizeBucket).toBe("large");
    expect(toShapes({ churn: 1000, changedFiles: 1 }).sizeBucket).toBe("very-large");
  });

  it("maps file counts to buckets at the boundaries", () => {
    expect(toShapes({ churn: 1, changedFiles: 1 }).fileCountBucket).toBe("1");
    expect(toShapes({ churn: 1, changedFiles: 2 }).fileCountBucket).toBe("2-5");
    expect(toShapes({ churn: 1, changedFiles: 5 }).fileCountBucket).toBe("2-5");
    expect(toShapes({ churn: 1, changedFiles: 6 }).fileCountBucket).toBe("6-20");
    expect(toShapes({ churn: 1, changedFiles: 20 }).fileCountBucket).toBe("6-20");
    expect(toShapes({ churn: 1, changedFiles: 21 }).fileCountBucket).toBe("21-100");
    expect(toShapes({ churn: 1, changedFiles: 100 }).fileCountBucket).toBe("21-100");
    expect(toShapes({ churn: 1, changedFiles: 101 }).fileCountBucket).toBe("101+");
  });

  it("always reports truncated false in this revision", () => {
    expect(toShapes({ churn: 5000, changedFiles: 500 }).truncated).toBe(false);
  });

  it("carries no array field and exactly three keys", () => {
    const shapes = toShapes({ churn: 100, changedFiles: 10 });
    for (const value of Object.values(shapes)) {
      expect(Array.isArray(value)).toBe(false);
    }
    expect(Object.keys(shapes).sort()).toEqual(["fileCountBucket", "sizeBucket", "truncated"]);
  });

  it("maps size buckets to advisory multipliers", () => {
    expect(advisoryMultiplier("trivial")).toBe(0.5);
    expect(advisoryMultiplier("small")).toBe(1);
    expect(advisoryMultiplier("medium")).toBe(2);
    expect(advisoryMultiplier("large")).toBe(4);
    expect(advisoryMultiplier("very-large")).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/enrich/buckets.test.ts)`
Expected: FAIL — cannot resolve `../../src/enrich/buckets.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/router/src/enrich/buckets.ts`:

```ts
/**
 * The only enrichment type that reaches TypeSafe state.
 *
 * It carries no free-form string and no array, so it can hold neither a file path nor
 * an attacker-chosen ordering. Its full domain is 5 x 5 x 2 = 50 states.
 */
export interface EnrichmentShapes {
  sizeBucket: "trivial" | "small" | "medium" | "large" | "very-large";
  fileCountBucket: "1" | "2-5" | "6-20" | "21-100" | "101+";
  truncated: boolean;
}

export function toShapes(input: { churn: number; changedFiles: number }): EnrichmentShapes {
  return {
    sizeBucket: sizeBucket(input.churn),
    fileCountBucket: fileCountBucket(input.changedFiles),
    truncated: false,
  };
}

function sizeBucket(churn: number): EnrichmentShapes["sizeBucket"] {
  if (churn < 10) {
    return "trivial";
  }
  if (churn < 50) {
    return "small";
  }
  if (churn < 250) {
    return "medium";
  }
  if (churn < 1000) {
    return "large";
  }
  return "very-large";
}

function fileCountBucket(files: number): EnrichmentShapes["fileCountBucket"] {
  if (files <= 1) {
    return "1";
  }
  if (files <= 5) {
    return "2-5";
  }
  if (files <= 20) {
    return "6-20";
  }
  if (files <= 100) {
    return "21-100";
  }
  return "101+";
}

/** Recorded for later calibration of the cost estimate. Never applied to it today. */
export function advisoryMultiplier(bucket: EnrichmentShapes["sizeBucket"]): number {
  const table: Record<EnrichmentShapes["sizeBucket"], number> = {
    trivial: 0.5,
    small: 1,
    medium: 2,
    large: 4,
    "very-large": 8,
  };
  return table[bucket];
}
```

A churn of `0` never reaches this function; the resolver reports `empty-diff` first.

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/router && npx vitest run test/enrich/buckets.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/enrich/buckets.ts packages/router/test/enrich/buckets.test.ts
git commit -m "feat: bucket pull request size for the classifier"
```

---

### Task 5: The `gh` resolver

**Files:**

- Create: `packages/router/src/enrich/resolver.ts`
- Test: `packages/router/test/enrich/resolver.test.ts`

**Interfaces:**

- Consumes: `detectPrRefs` (Task 3); `runCommand` with `code`/`timedOut`/`cwd` (Task 2).
- Produces: `Resolution`; `UnresolvedReason`; `resolveEnrichment(input): Promise<Resolution>`; `resolverEnv(env): NodeJS.ProcessEnv`.

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/enrich/resolver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveEnrichment, resolverEnv } from "../../src/enrich/resolver.js";
import type { runCommand } from "../../src/collectors/command-runner.js";

type Input = Parameters<typeof runCommand>[0];
type Scripted = Record<
  string,
  { ok: boolean; stdout?: string; code?: number | null; timedOut?: boolean }
>;

function scripted(responses: Scripted, inspect?: (input: Input) => void): typeof runCommand {
  return async (input: Input) => {
    inspect?.(input);
    const response = responses[`${input.command} ${input.args[0]}`] ?? { ok: false, code: 1 };
    return {
      ok: response.ok,
      stdout: response.stdout ?? "",
      stderr: "",
      code: response.code ?? (response.ok ? 0 : 1),
      timedOut: response.timedOut ?? false,
      executedReturnedOutput: false as const,
    };
  };
}

const toplevel = { ok: true, stdout: "/repo\n" };
const origin = { ok: true, stdout: "git@github.com:owner/repo.git\n" };

function prPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    additions: 300,
    deletions: 112,
    changedFiles: 9,
    url: "https://github.com/owner/repo/pull/9",
    isCrossRepository: false,
    ...over,
  });
}

function happy(over: Record<string, unknown> = {}): Scripted {
  return {
    "git rev-parse": toplevel,
    "git remote": origin,
    "gh pr": { ok: true, stdout: prPayload(over) },
  };
}

describe("resolveEnrichment", () => {
  it("skips without a subprocess when no ref is present", async () => {
    const run = vi.fn();
    const result = await resolveEnrichment({
      task: "add a dark mode toggle",
      run: run as unknown as typeof runCommand,
      env: {},
    });
    expect(result).toEqual({ status: "skipped" });
    expect(run).not.toHaveBeenCalled();
  });

  it("resolves a PR to churn and file count", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy()),
      env: {},
    });
    expect(result).toEqual({
      status: "resolved",
      churn: 412,
      changedFiles: 9,
      prNumber: 9,
      repo: { owner: "owner", name: "repo" },
      isCrossRepository: false,
    });
  });

  it("passes only the parsed integer and fixed flags to gh", async () => {
    const inspect = vi.fn();
    await resolveEnrichment({
      task: "refactor PR 9 --output=/tmp/x",
      run: scripted(happy(), inspect),
      env: {},
    });
    const calls = inspect.mock.calls.map(([input]) => input as Input);
    const ghCall = calls.find((input) => input.command === "gh")!;
    expect(ghCall.args).toEqual([
      "pr",
      "view",
      "9",
      "--json",
      "additions,deletions,changedFiles,url,isCrossRepository",
    ]);
    expect(ghCall.cwd).toBe("/repo");
  });

  it("resolves only the first ref and makes one gh call", async () => {
    const inspect = vi.fn();
    await resolveEnrichment({
      task: "compare PR 10 with PR 9",
      run: scripted(happy({ url: "https://github.com/owner/repo/pull/10" }), inspect),
      env: {},
    });
    const ghCalls = inspect.mock.calls
      .map(([input]) => input as Input)
      .filter((input) => input.command === "gh");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args[2]).toBe("10");
  });

  it.each([
    ["not-a-repository", { "git rev-parse": { ok: false, code: 128 } }],
    [
      "gh-not-installed",
      { "git rev-parse": toplevel, "git remote": origin, "gh pr": { ok: false, code: null } },
    ],
    [
      "timed-out",
      {
        "git rev-parse": toplevel,
        "git remote": origin,
        "gh pr": { ok: false, code: null, timedOut: true },
      },
    ],
    [
      "gh-not-authenticated",
      { "git rev-parse": toplevel, "git remote": origin, "gh pr": { ok: false, code: 4 } },
    ],
    [
      "pr-not-found",
      { "git rev-parse": toplevel, "git remote": origin, "gh pr": { ok: false, code: 1 } },
    ],
  ])("reports %s", async (reason, responses) => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(responses as Scripted),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason });
  });

  it("reports repo-mismatch when the PR url names a different repository", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy({ url: "https://github.com/attacker/other/pull/9" })),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "repo-mismatch" });
  });

  it("reports empty-diff for a zero-churn PR", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy({ additions: 0, deletions: 0 })),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "empty-diff" });
  });

  it("reports malformed-response for unusable payloads", async () => {
    const payloads = [
      "{not json",
      JSON.stringify({
        additions: null,
        deletions: 1,
        changedFiles: 1,
        url: "https://github.com/owner/repo/pull/9",
      }),
      JSON.stringify({
        additions: "x",
        deletions: 1,
        changedFiles: 1,
        url: "https://github.com/owner/repo/pull/9",
      }),
      JSON.stringify({ additions: 1, deletions: 1, changedFiles: 1, url: "not-a-url" }),
    ];
    for (const stdout of payloads) {
      const result = await resolveEnrichment({
        task: "refactor PR 9",
        run: scripted({
          "git rev-parse": toplevel,
          "git remote": origin,
          "gh pr": { ok: true, stdout },
        }),
        env: {},
      });
      expect(result).toEqual({ status: "unresolved", reason: "malformed-response" });
    }
  });

  it("never throws on hostile subprocess output", async () => {
    const hostile = ["", "null", "[]", '{"additions":{}}', String.fromCharCode(0)];
    for (const stdout of hostile) {
      const result = await resolveEnrichment({
        task: "refactor PR 9",
        run: scripted({
          "git rev-parse": toplevel,
          "git remote": origin,
          "gh pr": { ok: true, stdout },
        }),
        env: {},
      });
      expect(result.status).toBe("unresolved");
    }
  });
});

describe("resolverEnv", () => {
  it("forwards auth variables and drops redirect variables", () => {
    const env = resolverEnv({
      PATH: "/bin",
      HOME: "/home/u",
      GH_TOKEN: "t",
      GH_REPO: "attacker/repo",
      GH_HOST: "evil.example",
      GH_CONFIG_DIR: "/tmp/cfg",
      GH_PATH: "/tmp/gh",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBe("t");
    expect(env.GH_REPO).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBeUndefined();
    expect(env.GH_PATH).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/enrich/resolver.test.ts)`
Expected: FAIL — cannot resolve `../../src/enrich/resolver.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/router/src/enrich/resolver.ts`:

```ts
import type { runCommand } from "../collectors/command-runner.js";
import { detectPrRefs } from "./ref-detector.js";

export type UnresolvedReason =
  | "not-a-repository"
  | "gh-not-installed"
  | "gh-not-authenticated"
  | "github-unavailable"
  | "timed-out"
  | "pr-not-found"
  | "repo-mismatch"
  | "empty-diff"
  | "malformed-response";

export type Resolution =
  | {
      status: "resolved";
      churn: number;
      changedFiles: number;
      prNumber: number;
      repo: { owner: string; name: string };
      isCrossRepository: boolean;
    }
  | { status: "skipped" }
  | { status: "unresolved"; reason: UnresolvedReason };

/** One network hop on an interactive path; the 5s collector timeout is too generous. */
const RESOLVER_TIMEOUT_MS = 2_000;
const RESOLVER_MAX_BYTES = 65_536;

/**
 * Variables `gh` reads that redirect the request or the credential are never forwarded.
 * `GH_REPO` accepts `[HOST/]OWNER/REPO`, the same redirect the `-R` flag provides.
 * Generic enterprise tokens are also excluded because the repository controls the host.
 */
const FORWARDED = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const;

export function resolverEnv(env: NodeJS.Dict<string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED) {
    const value = env[key];
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

export async function resolveEnrichment(input: {
  task: string;
  run: typeof runCommand;
  env: NodeJS.Dict<string>;
}): Promise<Resolution> {
  const prNumber = detectPrRefs(input.task)[0];
  if (prNumber === undefined) {
    return { status: "skipped" };
  }

  const run = (command: string, args: string[], cwd?: string) =>
    input.run({
      command,
      args,
      timeoutMs: RESOLVER_TIMEOUT_MS,
      maxBytes: RESOLVER_MAX_BYTES,
      env: resolverEnv(input.env),
      cwd,
    });

  const toplevel = await run("git", ["rev-parse", "--show-toplevel"]);
  const cwd = toplevel.stdout.trim();
  if (!toplevel.ok || cwd.length === 0) {
    return { status: "unresolved", reason: "not-a-repository" };
  }

  const remote = await run("git", ["remote", "get-url", "origin"], cwd);
  const local = remote.ok ? parseRemote(remote.stdout.trim()) : undefined;

  // The PR number is re-emitted from a parsed integer, never the matched substring.
  const view = await run(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "additions,deletions,changedFiles,url,isCrossRepository",
    ],
    cwd,
  );
  if (!view.ok) {
    return { status: "unresolved", reason: ghFailure(view.code, view.timedOut) };
  }

  const parsed = parsePayload(view.stdout);
  if (!parsed) {
    return { status: "unresolved", reason: "malformed-response" };
  }
  if (local && !sameRepo(local, parsed.repo)) {
    return { status: "unresolved", reason: "repo-mismatch" };
  }
  const churn = parsed.additions + parsed.deletions;
  if (churn === 0 || parsed.changedFiles === 0) {
    return { status: "unresolved", reason: "empty-diff" };
  }
  return {
    status: "resolved",
    churn,
    changedFiles: parsed.changedFiles,
    prNumber,
    repo: parsed.repo,
    isCrossRepository: parsed.isCrossRepository,
  };
}

interface Repo {
  owner: string;
  name: string;
}

function sameRepo(left: Repo, right: Repo): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function ghFailure(code: number | null, timedOut: boolean): UnresolvedReason {
  if (timedOut) {
    return "timed-out";
  }
  if (code === null) {
    return "gh-not-installed";
  }
  if (code === 4) {
    return "gh-not-authenticated";
  }
  if (code === 1) {
    // Not found and private-without-access are indistinguishable without reading
    // stderr, which must not be treated as data. Both report not found.
    return "pr-not-found";
  }
  return "github-unavailable";
}

function parseRemote(url: string): Repo | undefined {
  const match = /[/:]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(url);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

interface Payload {
  additions: number;
  deletions: number;
  changedFiles: number;
  repo: Repo;
  isCrossRepository: boolean;
}

function parsePayload(stdout: string): Payload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const additions = finite(record.additions);
  const deletions = finite(record.deletions);
  const changedFiles = finite(record.changedFiles);
  const repo = typeof record.url === "string" ? parsePrUrl(record.url) : undefined;
  if (additions === undefined || deletions === undefined || changedFiles === undefined || !repo) {
    return undefined;
  }
  return {
    additions,
    deletions,
    changedFiles,
    repo,
    isCrossRepository: record.isCrossRepository === true,
  };
}

/** `NaN` is a `number` to TypeScript and is rejected by zod, so it must not escape here. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parsePrUrl(url: string): Repo | undefined {
  const match = /^https?:\/\/[^/]+\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/\d+$/.exec(
    url,
  );
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/router && npx vitest run test/enrich/resolver.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/enrich/resolver.ts packages/router/test/enrich/resolver.test.ts
git commit -m "feat: resolve a pull request reference to its size through gh"
```

---

### Task 6: Wire enrichment into routing, the card, and the JSON output

**Files:**

- Modify: `packages/router/src/semantic/decision-engine.ts`
- Modify: `packages/router/src/commands/run.ts`
- Modify: `packages/router/src/presentation/decision-card.ts`
- Test: `packages/router/test/cli/run.test.ts`

**Interfaces:**

- Consumes: `resolveEnrichment`, `Resolution` (Task 5); `toShapes`, `EnrichmentShapes` (Task 4); `RunDeps.runCommand` (Task 2).
- Produces: `DecideRouteInput` gains `enrichment?: EnrichmentShapes`; `result.json.enrichment`; a `Task size:` card line.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/cli/run.test.ts`, using that file's existing helper for building deps. Copy the `scripted` helper from Task 5 into this file rather than importing across test directories, and add the walker below:

```ts
/** Walks any value and fails on a string that looks like a path or a filename. */
function expectNoPathLike(value: unknown): void {
  if (typeof value === "string") {
    expect(value).not.toMatch(/\//);
    expect(value).not.toMatch(/\.[a-z]{1,5}$/i);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      expectNoPathLike(item);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      expectNoPathLike(item);
    }
  }
}

const resolved = {
  "git rev-parse": { ok: true, stdout: "/repo\n" },
  "git remote": { ok: true, stdout: "git@github.com:owner/repo.git\n" },
  "gh pr": {
    ok: true,
    stdout: JSON.stringify({
      additions: 300,
      deletions: 112,
      changedFiles: 9,
      url: "https://github.com/owner/repo/pull/9",
      isCrossRepository: false,
    }),
  },
};

it("resolves a PR reference into the decision card and the json block", async () => {
  const result = await executeRun(
    "refactor PR 9",
    { dryRun: true },
    { ...baseDeps(), runCommand: scripted(resolved) },
  );
  expect(result.output).toContain(
    "Task size: large (250-999 lines), 6-20 files (PR #9 in owner/repo)",
  );
  expect((result.json as { enrichment: unknown }).enrichment).toEqual({
    status: "resolved",
    prNumber: 9,
    repo: "owner/repo",
    sizeBucket: "large",
    fileCountBucket: "6-20",
  });
});

it("routes normally and reports the reason when resolution fails", async () => {
  const result = await executeRun(
    "refactor PR 9",
    { dryRun: true },
    {
      ...baseDeps(),
      runCommand: scripted({
        "git rev-parse": { ok: true, stdout: "/repo\n" },
        "git remote": { ok: true, stdout: "git@github.com:owner/repo.git\n" },
        "gh pr": { ok: false, code: 4 },
      }),
    },
  );
  expect(result.code).toBe(0);
  expect(result.output).toContain("Task size: unresolved (gh-not-authenticated)");
});

it("omits the card line and makes no subprocess call when no ref is present", async () => {
  const run = vi.fn();
  const result = await executeRun(
    "add a dark mode toggle",
    { dryRun: true },
    { ...baseDeps(), runCommand: run as never },
  );
  expect(result.output).not.toContain("Task size:");
  expect(run).not.toHaveBeenCalled();
  expect((result.json as { enrichment: { status: string } }).enrichment.status).toBe("skipped");
});

it("sends only bucketed enrichment to TypeSafe, never a path", async () => {
  const client = scriptedClient({});
  await executeRun(
    "refactor PR 9",
    { dryRun: true },
    { ...baseDeps(), client, runCommand: scripted(resolved) },
  );
  expect(client.calls.length).toBeGreaterThan(0);
  for (const call of client.calls) {
    for (const [key, value] of Object.entries(call.state as Record<string, unknown>)) {
      if (key === "task") {
        continue;
      }
      expectNoPathLike(value);
    }
  }
});
```

The egress test skips `state.task` **by key path**, not by inspecting the value. Scoping it to the enrichment subtree instead would assert only what the type already guarantees, and an unforeseen field by definition arrives somewhere else.

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/cli/run.test.ts)`
Expected: FAIL — `runCommand` is not consumed by `executeRun`; no `enrichment` in the JSON; no card line.

- [ ] **Step 3: Accept enrichment in `decideRoute`**

In `packages/router/src/semantic/decision-engine.ts`, add:

```ts
import type { EnrichmentShapes } from "../enrich/buckets.js";
```

and the input field:

```ts
  /** Bucketed task size. Never carries a path; see enrich/buckets.ts. */
  enrichment?: EnrichmentShapes;
```

Include it in the classification state:

```ts
const classificationState = {
  task: input.task,
  candidateCount: input.candidates.length,
  ...(input.enrichment ? { enrichment: input.enrichment } : {}),
};
```

And in the effort state, where task size bears most directly on the answer:

```ts
      state: {
        task: input.task,
        family,
        phase,
        complexity: classification.answers.complexity.score,
        creativity: classification.answers.creativity.score,
        ...(input.enrichment ? { enrichment: input.enrichment } : {}),
      },
```

Do **not** add it to the ranking state, which concerns account and model capacity rather than task size.

- [ ] **Step 4: Resolve and thread through `executeRun`**

In `packages/router/src/commands/run.ts`, add imports:

```ts
import { runCommand as defaultRunCommand } from "../collectors/command-runner.js";
import { resolveEnrichment, type Resolution } from "../enrich/resolver.js";
import { toShapes, type EnrichmentShapes } from "../enrich/buckets.js";
```

After the `previous` lookup and before the eligibility loop:

```ts
const resolution = await resolveEnrichment({
  task,
  run: deps.runCommand ?? defaultRunCommand,
  env: deps.env,
});
const enrichment =
  resolution.status === "resolved"
    ? toShapes({ churn: resolution.churn, changedFiles: resolution.changedFiles })
    : undefined;
```

Pass `enrichment` into the `decideRoute` call, add `taskSize: formatTaskSize(resolution, enrichment)` to the `formatDecisionCard` input, and add `enrichment: enrichmentJson(resolution, enrichment)` to the returned `json` object.

Add these helpers at the bottom of the file:

```ts
function enrichmentJson(
  resolution: Resolution,
  shapes: EnrichmentShapes | undefined,
): Record<string, unknown> {
  if (resolution.status === "skipped") {
    return { status: "skipped" };
  }
  if (resolution.status === "unresolved") {
    return { status: "unresolved", reason: resolution.reason };
  }
  return {
    status: "resolved",
    prNumber: resolution.prNumber,
    repo: `${resolution.repo.owner}/${resolution.repo.name}`,
    sizeBucket: shapes!.sizeBucket,
    fileCountBucket: shapes!.fileCountBucket,
  };
}

const SIZE_LABEL: Record<EnrichmentShapes["sizeBucket"], string> = {
  trivial: "trivial (1-9 lines)",
  small: "small (10-49 lines)",
  medium: "medium (50-249 lines)",
  large: "large (250-999 lines)",
  "very-large": "very-large (1000+ lines)",
};

function formatTaskSize(
  resolution: Resolution,
  shapes: EnrichmentShapes | undefined,
): string | undefined {
  if (resolution.status === "skipped") {
    return undefined;
  }
  if (resolution.status === "unresolved") {
    return `unresolved (${resolution.reason})`;
  }
  const { owner, name } = resolution.repo;
  return `${SIZE_LABEL[shapes!.sizeBucket]}, ${shapes!.fileCountBucket} files (PR #${resolution.prNumber} in ${owner}/${name})`;
}
```

The owner and name reaching the card were validated by `parsePrUrl` against `^[A-Za-z0-9-]{1,39}$` and `^[A-Za-z0-9._-]{1,100}$`, so the line keeps a fixed shape even when the local checkout is a clone of an attacker-named repository.

- [ ] **Step 5: Add the card line**

In `packages/router/src/presentation/decision-card.ts`, add `taskSize?: string;` to the input type and this entry to the array, directly after the `Phase` line:

```ts
    input.taskSize ? `Task size: ${input.taskSize}` : undefined,
```

- [ ] **Step 6: Run the full suite**

Run: `(cd packages/router && npx vitest run)`
Expected: PASS. Existing `run.test.ts` cases that pass no `runCommand` resolve to `{ status: "skipped" }`, because their task strings contain no PR reference.

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/semantic/decision-engine.ts packages/router/src/commands/run.ts packages/router/src/presentation/decision-card.ts packages/router/test/cli/run.test.ts
git commit -m "feat: give the classifier a measured task size"
```

---

### Task 7: `--no-enrich`, config, and the privacy record

**Files:**

- Modify: `packages/router/src/cli.ts`
- Modify: `packages/router/src/config/config-schema.ts`
- Modify: `packages/router/src/commands/run.ts`
- Modify: `packages/router/src/commands/runtime.ts`
- Modify: `docs/privacy.md`
- Test: `packages/router/test/cli/entrypoint.test.ts`

**Interfaces:**

- Consumes: `executeRun` options (Task 6).
- Produces: `executeRun` options gain `noEnrich?: boolean`; `RunDeps` gains `enrichmentEnabled?: boolean`; config gains `enrichment.enabled`.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/cli/entrypoint.test.ts`, matching that file's existing invocation style:

```ts
it("passes --no-enrich through to executeRun", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, output: "", json: {} });
  await runCli(["run", "refactor PR 9", "--dry-run", "--no-enrich"], {
    run,
    runDeps: {} as never,
  });
  expect(run).toHaveBeenCalledWith(
    "refactor PR 9",
    expect.objectContaining({ noEnrich: true }),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/router && npx vitest run test/cli/entrypoint.test.ts -t "no-enrich")`
Expected: FAIL — the option is not registered.

- [ ] **Step 3: Register the flag**

In `packages/router/src/cli.ts`, add to the `run` command:

```ts
    .option("--no-enrich", "Skip pull request size resolution")
```

Commander maps `--no-enrich` to `flags.enrich === false`. Widen the `flags` type with `enrich?: boolean` and pass it through:

```ts
            flags.session
              ? {
                  dryRun: Boolean(flags.dryRun),
                  previousSessionId: flags.session,
                  noEnrich: flags.enrich === false,
                }
              : { dryRun: Boolean(flags.dryRun), noEnrich: flags.enrich === false },
```

- [ ] **Step 4: Honor the option and config**

In `packages/router/src/commands/run.ts`, widen the options parameter:

```ts
  options: { dryRun: boolean; previousSessionId?: string; noEnrich?: boolean },
```

add `enrichmentEnabled?: boolean;` to `RunDeps`, and guard the resolver call:

```ts
const enrichmentOff = options.noEnrich === true || deps.enrichmentEnabled === false;
const resolution: Resolution = enrichmentOff
  ? { status: "skipped" }
  : await resolveEnrichment({
      task,
      run: deps.runCommand ?? defaultRunCommand,
      env: deps.env,
    });
```

In `packages/router/src/config/config-schema.ts`, add to the root config object:

```ts
  enrichment: z.object({ enabled: z.boolean().default(true) }).optional(),
```

In `packages/router/src/commands/runtime.ts`, inside `createDefaultRunDeps`'s returned object:

```ts
    enrichmentEnabled: config.enrichment?.enabled ?? true,
```

- [ ] **Step 5: Record the egress in the privacy doc**

Add to `docs/privacy.md`, after the first bullet:

```markdown
- Task enrichment sends a bucketed pull request size to TypeSafe: one of five size
  buckets, one of five file-count buckets, and a boolean — at most ~5.6 bits per run
  describing a repository's diff. No file path, branch name, pull request title, or
  repository name is sent. Disable it with `router run --no-enrich`, or by setting
  `enrichment.enabled` to `false` in config.
```

- [ ] **Step 6: Run the suite and the formatter**

Run: `(cd packages/router && npx vitest run) && npx prettier --check docs/privacy.md`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/cli.ts packages/router/src/config/config-schema.ts packages/router/src/commands/run.ts packages/router/src/commands/runtime.ts packages/router/test/cli/entrypoint.test.ts docs/privacy.md
git commit -m "feat: allow disabling pull request size resolution"
```

---

## Self-Review

**Spec coverage.** Ref syntax, resolver contract, repository identity, subprocess environment, S1 through S5, thresholds, the flow through `decideRoute`, limits, the failure matrix, the output shape, the prerequisite, and the testing list each map to a task. Two deliberate deviations from the spec text:

1. The spec says repository identity comes from `gh repo view --json nameWithOwner`. That is a second network call, contradicting "at most one `gh` call per run", so the plan uses `git remote get-url origin`, which is local. `gh pr view` already resolves against the local repository's remote, so the comparison is confirmation rather than discovery. The spec's "Repository identity" section should be amended to match.
2. The spec's `Resolution` omits `isCrossRepository`; the plan carries it so the deferred handoff spec can gate on it without another `gh` field change. It is never rendered and never reaches TypeSafe.

**Placeholder scan.** No TBDs; every step carries the code it needs.

**Type consistency.** `EnrichmentShapes` (Task 4) is the type `decideRoute` accepts (Task 6). `UnresolvedReason` (Task 5) is the type of `enrichment.reason` (Task 6). `CommandResult.code`/`timedOut` (Task 2) are what `ghFailure` reads (Task 5). `RunDeps.runCommand` (Task 2) is what `executeRun` consumes (Task 6).
