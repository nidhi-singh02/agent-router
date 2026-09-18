import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createProgram, runCli } from "../../src/cli.js";
import { executeRun } from "../../src/commands/run.js";
import type { runCommand } from "../../src/collectors/command-runner.js";
import { collectUsageChain } from "../../src/collectors/collector-chain.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "./fixtures.js";

async function captureHelp(): Promise<string> {
  let out = "";
  const program = createProgram({
    stdout: {
      write(chunk: string) {
        out += chunk;
        return true;
      },
    },
    env: { MODEL_ROUTER_HOME: mkdtempSync(path.join(os.tmpdir(), "router-cli-")) },
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "router", "--help"]);
  } catch {
    // commander throws after help when exitOverride is set
  }
  return out;
}

type ScriptInput = Parameters<typeof runCommand>[0];
type Scripted = Record<
  string,
  { ok: boolean; stdout?: string; code?: number | null; timedOut?: boolean }
>;

function scripted(responses: Scripted): typeof runCommand {
  return async (input: ScriptInput) => {
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

function baseDeps() {
  return {
    accounts: [personal],
    models: [cursorModel],
    usage: { [personal.id]: usageFor(personal.id, 0.8) },
    client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
    env: { HERDR_ENV: "1" },
    now,
  };
}

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

describe("router run", () => {
  it("prints help for the explicit CLI", async () => {
    const help = await captureHelp();
    expect(help).toMatch(/Usage: router/);
    expect(help).toMatch(/run/);
    expect(help).toMatch(/status/);
  });

  it("reports the package version", async () => {
    const { version } = createRequire(import.meta.url)("../../package.json") as {
      version: string;
    };
    let out = "";
    const program = createProgram({
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      env: { MODEL_ROUTER_HOME: mkdtempSync(path.join(os.tmpdir(), "router-cli-")) },
    });
    program.exitOverride();
    try {
      await program.parseAsync(["node", "router", "--version"]);
    } catch {
      // commander throws after printing the version when exitOverride is set
    }
    expect(out.trim()).toBe(version);
  });

  it("selects a safe dry-run route and prints the decision card", async () => {
    const reservations = new ReservationService(() => now.getTime());
    const result = await executeRun(
      "Implement the approved session repository plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: { HERDR_ENV: "1" },
        now,
        reservations,
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Selected: cursor \/ grok-4\.6 \/ medium/);
    expect(result.output).toMatch(/Phase: implementation/);
    expect(result.output).toMatch(/Cache decision: no previous session/);
    expect(result.output).toMatch(/Usage source:/);
    expect(result.output).toMatch(/exact/);
    expect(result.output).toMatch(/cursor-grok-4\.6-medium/);
    expect(result.json).toMatchObject({ ok: true, dryRun: true });
    expect(reservations.activeRatio(personal.id)).toBe(0);
  });

  it("reports no eligible route without calling TypeSafe ranking", async () => {
    const client = fakeTypeSafe({});
    const result = await executeRun(
      "Implement the plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.3) },
        client,
        env: {},
        now,
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/No eligible route/);
    expect(result.output).toMatch(/below-reserve/);
    expect(client.calls).toEqual([]);
  });

  it("presents the top two eligible routes when confidence is low and consequence is high", async () => {
    const personalOpaque = `${personal.id}:${cursorModel.id}`;
    const sharedOpaque = `${shared.id}:${claudeModel.id}`;
    const result = await executeRun(
      "Plan a high-stakes architecture change.",
      { dryRun: true },
      {
        accounts: [personal, shared],
        models: [cursorModel, claudeModel],
        usage: {
          [personal.id]: usageFor(personal.id, 0.9),
          [shared.id]: usageFor(shared.id, 0.8),
        },
        client: fakeTypeSafe({
          family: "planning",
          phase: "planning",
          consequence: 3,
          route: personalOpaque,
          routeConfidence: 0.5,
          routeProbabilities: { [personalOpaque]: 0.48, [sharedOpaque]: 0.42 },
        }),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(3);
    expect(result.output).toMatch(/Low confidence/);
    expect(result.output).toContain(personalOpaque);
    expect(result.output).toContain(sharedOpaque);
  });

  it("prevents a duplicate pane split on retry with the same launch token", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const deps = {
      accounts: [personal],
      models: [cursorModel],
      usage: { [personal.id]: usageFor(personal.id, 0.8) },
      client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
      env: { HERDR_ENV: "1" },
      now,
      herdr,
    };
    const first = await executeRun("Implement the approved plan.", { dryRun: false }, deps);
    expect(first.code).toBe(0);
    const second = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      {
        ...deps,
        existingLaunchToken: (first.json as { launchToken?: string }).launchToken,
        existingPaneId: (first.json as { paneId?: string }).paneId,
      },
    );
    expect(second.code).toBe(0);
    expect(calls.filter((argv) => argv[1] === "pane" && argv[2] === "split")).toHaveLength(1);
  });

  it("excludes a shared account the coordinator reports as constrained, even with known quota", async () => {
    const client = fakeTypeSafe({ family: "implementation" });
    const status = vi.fn(async () => "constrained" as const);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.85) },
        client,
        env: {},
        now,
        activityClient: { status },
      },
    );
    expect(status).toHaveBeenCalledWith(shared.id);
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/shared-activity-constrained/);
    expect(client.calls).toEqual([]);
  });

  it("routes a shared account on known quota when the coordinator is unavailable", async () => {
    const client = fakeTypeSafe({ family: "implementation", phase: "implementation" });
    const status = vi.fn(async () => "unreachable" as const);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.85) },
        client,
        env: {},
        now,
        activityClient: { status },
      },
    );
    expect(result.code).toBe(0);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(result.output).toContain(
      "Shared activity: unknown (coordinator unavailable); routed on quota",
    );
    expect(result.output).toContain("Reserve policy: 40% protected");
  });

  it("still enforces the 40% reserve when the coordinator is unavailable", async () => {
    const client = fakeTypeSafe({ family: "implementation" });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.41) },
        client,
        env: {},
        now,
        activityClient: { status: async () => "unreachable" as const },
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/below-reserve/);
    expect(client.calls).toEqual([]);
  });

  it("excludes a shared account when the coordinator is unavailable and usage is unknown", async () => {
    const client = fakeTypeSafe({ family: "implementation" });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: {
          [shared.id]: usageFor(shared.id, 0, {
            windows: [{ kind: "five-hour" }],
            source: "skipped",
            certainty: "unknown",
          }),
        },
        client,
        env: {},
        now,
        activityClient: { status: async () => "unreachable" as const },
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/shared-activity-constrained/);
    expect(client.calls).toEqual([]);
  });

  it("keeps a shared account eligible when activity is inactive and still queried first", async () => {
    const client = fakeTypeSafe({ family: "implementation", phase: "implementation" });
    const status = vi.fn(async () => "inactive" as const);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.85) },
        client,
        env: {},
        now,
        activityClient: { status },
      },
    );
    expect(status).toHaveBeenCalledWith(shared.id);
    expect(result.code).toBe(0);
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("sends the task and constraints as a readable prompt", async () => {
    const prompts: string[] = [];
    const herdr = createHerdrClient(async (argv) => {
      if (argv[1] === "agent" && argv[2] === "prompt") {
        prompts.push(argv[4] ?? "");
      }
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: { HERDR_ENV: "1" },
        now,
        herdr,
      },
    );
    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(
      [
        "Implement the approved plan.",
        "",
        "Phase: implementation",
        "Constraints:",
        "- Do not deploy or publish anything without asking the user.",
      ].join("\n"),
    );
  });

  it("labels usage as unknown when no collector returned usage", async () => {
    const usage = await collectUsageChain(personal, []);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usage },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: {},
        now: new Date(),
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Usage source: unknown (no collector returned usage)");
    expect(result.output).not.toMatch(/Usage source:.*browser-dashboard/);
  });

  it("shows the pool quota used for the decision in the card", async () => {
    const composer = {
      ...cursorModel,
      id: "cursor:composer-2.5",
      launchName: "composer-2.5",
      quotaPool: "auto",
    } as typeof cursorModel;
    const account = { ...personal, enabledModels: [composer.id] };
    const usage = usageFor(personal.id, 0, {
      source: "local-session",
      certainty: "estimated",
      expiresAt: "2026-09-17T10:00:00.000Z",
      windows: [
        { kind: "monthly", pool: "spend", remainingRatio: 0, usedRatio: 1 },
        { kind: "monthly", pool: "auto", remainingRatio: 0.8, usedRatio: 0.2 },
      ],
    });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [account],
        models: [composer],
        usage: { [personal.id]: usage },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Usage source: estimated local-session");
    expect(result.output).toContain("Quota: auto 80% left (spend 0% left)");
  });

  it("labels skipped usage in the card and still routes a personal account", async () => {
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: {
          [personal.id]: usageFor(personal.id, 0, {
            windows: [{ kind: "five-hour" }],
            source: "skipped",
            certainty: "unknown",
            expiresAt: "2026-09-17T10:00:00.000Z",
          }),
        },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Usage source: skipped (run with --usage to check quota)");
    expect(result.output).not.toContain("Quota:");
  });

  it("uses local usage mode by default and full collectors with --usage", async () => {
    const createRunDeps = vi.fn(async () => ({
      accounts: [],
      models: [],
      usage: {},
      client: fakeTypeSafe({}),
      env: {},
    }));
    const home = mkdtempSync(path.join(os.tmpdir(), "router-no-usage-"));
    const silent = { write: () => true };
    await runCli(["node", "router", "run", "task", "--dry-run"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: home },
      createRunDeps,
    });
    await runCli(["node", "router", "run", "task", "--dry-run", "--usage"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: home },
      createRunDeps,
    });
    expect(createRunDeps.mock.calls[0][1]).toMatchObject({ usageMode: "local" });
    expect(createRunDeps.mock.calls[1][1]).toMatchObject({ usageMode: "full" });
  });

  it("adds the missing TypeSafe key hint when TypeSafe is unavailable", async () => {
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: {
          calls: [],
          systemOne: async () => {
            throw new Error("TypeSafe is not configured");
          },
        },
        env: {},
        now,
        typesafeKeyHint: "No TypeSafe API key found (checked TYPESAFE_API_KEY).",
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toBe(
      "TypeSafe could not select a route (typesafe-unavailable). No TypeSafe API key found (checked TYPESAFE_API_KEY).",
    );
  });
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
    const client = fakeTypeSafe({});
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
});
