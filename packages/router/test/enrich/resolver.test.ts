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
      code: response.code === undefined ? (response.ok ? 0 : 1) : response.code,
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
