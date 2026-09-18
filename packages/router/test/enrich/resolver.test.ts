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
      env: { PATH: "/bin", GH_TOKEN: "t", GH_REPO: "attacker/repo" },
    });
    const calls = inspect.mock.calls.map(([input]) => input as Input);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.env).toEqual({ PATH: "/bin", GH_TOKEN: "t" });
    }
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
    [
      "github-unavailable",
      { "git rev-parse": toplevel, "git remote": origin, "gh pr": { ok: false, code: 2 } },
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

  it("reports repo-mismatch when the PR url names a different host", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy({ url: "https://evil.example/owner/repo/pull/9" })),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "repo-mismatch" });
  });

  it.each([
    ["scp", "git@github.com:owner/repo.git\n"],
    ["https", "https://github.com/owner/repo.git\n"],
    ["ssh", "ssh://git@github.com/owner/repo\n"],
    ["https without suffix", "https://github.com/owner/repo\n"],
  ])("resolves when the %s remote form names the same host", async (_form, stdout) => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted({
        "git rev-parse": toplevel,
        "git remote": { ok: true, stdout },
        "gh pr": { ok: true, stdout: prPayload() },
      }),
      env: {},
    });
    expect(result).toMatchObject({ status: "resolved", churn: 412 });
  });

  it("reports repo-mismatch for an enterprise remote against a github.com PR url", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted({
        "git rev-parse": toplevel,
        "git remote": { ok: true, stdout: "git@github.example.com:owner/repo.git\n" },
        "gh pr": { ok: true, stdout: prPayload() },
      }),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "repo-mismatch" });
  });

  it("reports timed-out when the first call exceeds its timeout", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted({ "git rev-parse": { ok: false, code: null, timedOut: true } }),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "timed-out" });
  });

  it("reports timed-out when the remote lookup times out, without calling gh", async () => {
    const inspect = vi.fn();
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(
        {
          "git rev-parse": toplevel,
          "git remote": { ok: false, code: null, timedOut: true },
          "gh pr": { ok: true, stdout: prPayload() },
        },
        inspect,
      ),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "timed-out" });
    const calls = inspect.mock.calls.map(([input]) => input as Input);
    expect(calls.some((input) => input.command === "gh")).toBe(false);
  });

  it("resolves with the comparison skipped when the repository has no origin", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted({
        "git rev-parse": toplevel,
        "git remote": { ok: false, code: 2 },
        "gh pr": { ok: true, stdout: prPayload({ url: "https://github.com/other/repo/pull/9" }) },
      }),
      env: {},
    });
    expect(result).toMatchObject({ status: "resolved", churn: 412, changedFiles: 9 });
  });

  it("reports repo-mismatch when the origin remote does not parse", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted({
        "git rev-parse": toplevel,
        "git remote": { ok: true, stdout: "a note about the remote\n" },
        "gh pr": { ok: true, stdout: prPayload() },
      }),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "repo-mismatch" });
  });

  it("reports timed-out rather than rejecting when the runner throws", async () => {
    const throwing = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof runCommand;
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: throwing,
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "timed-out" });
  });

  it("stops spawning once the total budget is spent", async () => {
    const inspect = vi.fn();
    let clock = 0;
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy(), (input) => {
        inspect(input);
        clock += 2_000;
      }),
      env: {},
      now: () => clock,
    });
    expect(result).toEqual({ status: "unresolved", reason: "timed-out" });
    const calls = inspect.mock.calls.map(([input]) => input as Input);
    expect(calls).toHaveLength(2);
    expect(calls.some((input) => input.command === "gh")).toBe(false);
  });

  it("clamps each call to whichever of the per-call timeout and the budget is smaller", async () => {
    const inspect = vi.fn();
    let clock = 0;
    await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy(), (input) => {
        inspect(input);
        clock += 2_500;
      }),
      env: {},
      now: () => clock,
    });
    const calls = inspect.mock.calls.map(([input]) => input as Input);
    expect(calls[0]!.timeoutMs).toBe(2_000);
    expect(calls[1]!.timeoutMs).toBe(500);
  });

  it("reports empty-diff for a zero-churn PR", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy({ additions: 0, deletions: 0 })),
      env: {},
    });
    expect(result).toEqual({ status: "unresolved", reason: "empty-diff" });
  });

  it("reports empty-diff for a PR whose churn is non-zero but touches no files", async () => {
    const result = await resolveEnrichment({
      task: "refactor PR 9",
      run: scripted(happy({ changedFiles: 0 })),
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
      expect(result).toEqual({ status: "unresolved", reason: "malformed-response" });
    }
  });
});

describe("resolverEnv", () => {
  it("forwards github.com auth and drops generic enterprise credentials and redirects", () => {
    const env = resolverEnv({
      PATH: "/bin",
      HOME: "/home/u",
      GH_TOKEN: "t",
      GH_ENTERPRISE_TOKEN: "enterprise-token",
      GITHUB_ENTERPRISE_TOKEN: "enterprise-token-fallback",
      GH_REPO: "attacker/repo",
      GH_HOST: "evil.example",
      GH_CONFIG_DIR: "/tmp/cfg",
      GH_PATH: "/tmp/gh",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBe("t");
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_REPO).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBeUndefined();
    expect(env.GH_PATH).toBeUndefined();
  });
});
