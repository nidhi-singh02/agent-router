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
      expect(start?.[3]).toMatch(new RegExp(`^router-${kind}-[0-9a-f]{6}$`));
      expect([...start!.slice(0, 3), ...start!.slice(4)]).toEqual([
        "herdr",
        "agent",
        "start",
        "--kind",
        kind,
        "--pane",
        "w1:p9",
        "--",
        ...args,
      ]);
    },
  );

  it("waits for startup to settle, then confirms the agent picked up the handoff", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
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
    expect(result.ok).toBe(true);
    const name = result.agentName!;
    expect(name).toMatch(/^router-codex-[0-9a-f]{6}$/);
    const agentCalls = calls.filter((argv) => argv[1] === "agent").map((argv) => argv[2]);
    expect(agentCalls).toEqual(["start", "wait", "prompt"]);
    expect(calls.find((argv) => argv[2] === "wait")).toEqual([
      "herdr",
      "agent",
      "wait",
      name,
      "--timeout",
      "30000",
    ]);
    expect(calls.find((argv) => argv[2] === "prompt")).toEqual([
      "herdr",
      "agent",
      "prompt",
      name,
      "task",
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--timeout",
      "30000",
    ]);
  });

  it("reports a handoff the agent never picked up and keeps the agent pane", async () => {
    const calls: string[][] = [];
    let prompted = false;
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      if (argv[2] === "prompt") {
        prompted = true;
        return {
          ok: false,
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_prompt_stalled", message: "no activity observed" },
          }),
        };
      }
      // The confirming wait after a stall finds no activity either.
      if (argv[2] === "wait" && prompted) {
        return {
          ok: false,
          code: 1,
          stdout: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
          stderr: "",
        };
      }
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
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
      `handoff not received by agent ${result.agentName} in pane w1:p9 (agent_prompt_stalled: no activity observed); paste the task there or retry`,
    );
    expect(result.paneId).toBe("w1:p9");
    expect(calls.some((argv) => argv[2] === "close")).toBe(false);
    expect(calls.filter((argv) => argv[2] === "prompt")).toHaveLength(1);
  });

  it("treats a stalled prompt as launched when the agent starts working just after", async () => {
    const calls: string[][] = [];
    let prompted = false;
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      if (argv[2] === "prompt") {
        prompted = true;
        return {
          ok: false,
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_prompt_stalled", message: "no activity observed" },
          }),
        };
      }
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
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
    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("w1:p9");
    expect(prompted).toBe(true);
    expect(calls.some((argv) => argv[2] === "close")).toBe(false);
    const confirmingWait = calls.filter((argv) => argv[2] === "wait").at(-1);
    expect(confirmingWait).toEqual([
      "herdr",
      "agent",
      "wait",
      result.agentName,
      "--until",
      "working",
      "--until",
      "blocked",
      "--timeout",
      "30000",
    ]);
  });

  it("reports an agent that never finished starting without sending the handoff", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      if (argv[2] === "wait") {
        return {
          ok: false,
          code: 1,
          stdout: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
          stderr: "",
        };
      }
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
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
    expect(result.error).toBe("herdr agent wait failed: timeout: timed out");
    expect(result.paneId).toBe("w1:p9");
    expect(calls.some((argv) => argv[2] === "prompt")).toBe(false);
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
  });

  it("gives every launch its own Herdr agent name so the router can run repeatedly", async () => {
    const starts: string[][] = [];
    const prompts: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      if (argv[2] === "start") starts.push([...argv]);
      if (argv[2] === "prompt") prompts.push([...argv]);
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
    });
    const launch = () =>
      launchRoutedAgent({
        env: { HERDR_ENV: "1" },
        agent: "codex",
        launchName: "gpt-5.5",
        effort: "low",
        handoff: "task",
        dryRun: false,
        herdr,
      });
    const first = await launch();
    const second = await launch();
    expect(first.ok && second.ok).toBe(true);
    const names = starts.map((argv) => argv[3]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
    expect(prompts.map((argv) => argv[3])).toEqual(names);
    expect([first.agentName, second.agentName]).toEqual(names);
  });

  it("prompts the same agent name when retrying with an existing launch token and pane", async () => {
    const prompts: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      if (argv[2] === "prompt") prompts.push([...argv]);
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
    });
    const base = {
      env: { HERDR_ENV: "1" },
      agent: "claude-code" as const,
      launchName: "opus",
      effort: "high" as const,
      handoff: "task",
      dryRun: false,
      herdr,
    };
    const first = await launchRoutedAgent(base);
    await launchRoutedAgent({
      ...base,
      existingLaunchToken: first.launchToken,
      existingPaneId: first.paneId,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.[3]).toBe(prompts[0]?.[3]);
    expect(prompts[0]?.[3]).toMatch(/^router-claude-[0-9a-f]{6}$/);
  });

  it("closes the pane it created when the agent fails to start", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "pane" && argv[2] === "split") {
        return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
      }
      if (argv[2] === "start") {
        return {
          ok: false,
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_name_taken", message: "agent name is already used" },
          }),
        };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "codex",
      launchName: "gpt-5.5",
      effort: "low",
      handoff: "task",
      dryRun: false,
      herdr,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "herdr agent start failed: agent_name_taken: agent name is already used",
    );
    expect(calls).toContainEqual(["herdr", "pane", "close", "w1:p9"]);
    expect(result.paneId).toBeUndefined();
    expect(calls.some((argv) => argv[2] === "prompt")).toBe(false);
  });
});
