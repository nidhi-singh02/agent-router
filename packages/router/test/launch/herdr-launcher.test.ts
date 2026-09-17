import { describe, expect, it } from "vitest";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { launchRoutedAgent } from "../../src/launch/herdr-launcher.js";
import { buildHandoff, serializeHandoff } from "../../src/handoff/handoff-builder.js";

describe("herdr launcher", () => {
  it("errors clearly outside Herdr", async () => {
    const result = await launchRoutedAgent({
      env: {},
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "task",
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/HERDR_ENV/i);
    }
  });

  it("prints a redacted dry run with the verified Cursor model id and without creating a pane", async () => {
    const calls: string[][] = [];
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "fix token sk-secret-123",
      dryRun: true,
      herdr: createHerdrClient(async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paneCreated).toBe(false);
      expect(result.printed).toContain("cursor-grok-4.6-medium");
      expect(result.printed).not.toContain("--thinking");
      expect(result.printed).not.toContain("--force");
      expect(result.printed).not.toContain("sk-secret-123");
    }
    expect(calls).toEqual([]);
  });

  it("reuses a launch token instead of splitting a second pane", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const first = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "approved plan",
      dryRun: false,
      herdr,
    });
    const second = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "approved plan",
      dryRun: false,
      herdr,
      existingLaunchToken: first.launchToken,
      existingPaneId: first.paneId,
    });
    expect(second.ok).toBe(true);
    expect(calls.filter((argv) => argv[1] === "pane" && argv[2] === "split")).toHaveLength(1);
  });

  it("parses Herdr pane split JSON for result.pane.pane_id", async () => {
    const herdr = createHerdrClient(async (argv) => {
      if (argv[1] === "pane") {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: "pane_json_1" } } }),
          stderr: "",
        };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: serializeHandoff(
        buildHandoff({
          task: "Implement the approved plan",
          approvedSpec: "Use the spec",
          constraints: ["no live deploy"],
          currentPhase: "implementation",
          relevantFiles: ["src/a.ts"],
          completedChecks: ["tests"],
          remainingAcceptanceCriteria: ["launch"],
        }),
      ),
      dryRun: false,
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("pane_json_1");
  });

  it("falls back to plain-text pane ids when split output is not JSON", async () => {
    const herdr = createHerdrClient(async (argv) => {
      if (argv[1] === "pane") {
        return { ok: true, code: 0, stdout: "pane_plain\n", stderr: "" };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "approved plan",
      dryRun: false,
      herdr,
    });
    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("pane_plain");
  });

  it.each([
    {
      agent: "codex" as const,
      launchName: "gpt-5.6-terra",
      effort: "low" as const,
      kind: "codex",
      args: ["--model", "gpt-5.6-terra", "-c", 'model_reasoning_effort="low"'],
    },
    {
      agent: "claude-code" as const,
      launchName: "opus",
      effort: "high" as const,
      kind: "claude",
      args: ["--model", "opus", "--effort", "high"],
    },
    {
      agent: "cursor" as const,
      launchName: "grok-4.6",
      effort: "medium" as const,
      kind: "cursor",
      args: ["--model", "cursor-grok-4.6-medium"],
    },
    {
      agent: "opencode" as const,
      launchName: "openai",
      effort: "low" as const,
      kind: "opencode",
      args: ["--model", "openai"],
    },
  ])(
    "passes only native $agent arguments to herdr agent start",
    async ({ agent, launchName, effort, kind, args }) => {
      const calls: string[][] = [];
      const herdr = createHerdrClient(async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
      });
      const result = await launchRoutedAgent({
        env: { HERDR_ENV: "1" },
        agent,
        launchName,
        effort,
        handoff: "task",
        dryRun: false,
        herdr,
      });
      expect(result.ok).toBe(true);
      const start = calls.find((argv) => argv[1] === "agent" && argv[2] === "start");
      expect(start).toEqual([
        "herdr",
        "agent",
        "start",
        `router-${agent}`,
        "--kind",
        kind,
        "--pane",
        "w1:p9",
        "--",
        ...args,
      ]);
    },
  );

  it("sends the handoff without waiting for the agent to finish its turn", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
    });
    await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "codex",
      launchName: "gpt-5.6-terra",
      effort: "low",
      handoff: "task",
      dryRun: false,
      herdr,
    });
    const prompt = calls.find((argv) => argv[1] === "agent" && argv[2] === "prompt");
    expect(prompt).toEqual(["herdr", "agent", "prompt", "router-codex", "task"]);
  });

  it("reports Herdr JSON errors written to stdout", async () => {
    const herdr = createHerdrClient(async (argv) => {
      if (argv[1] === "pane") {
        return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
      }
      return {
        ok: false,
        code: 1,
        stdout: JSON.stringify({
          error: { code: "agent_not_ready", message: "codex did not become ready" },
          id: "cli:agent:start",
        }),
        stderr: "",
      };
    });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "codex",
      launchName: "gpt-5.6-terra",
      effort: "low",
      handoff: "task",
      dryRun: false,
      herdr,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "herdr agent start failed: agent_not_ready: codex did not become ready",
    );
    expect(result.paneId).toBe("w1:p9");
  });
});
