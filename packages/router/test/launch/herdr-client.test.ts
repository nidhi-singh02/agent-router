import { describe, expect, it } from "vitest";
import { createHerdrClient, createProcessCommandAdapter } from "../../src/launch/herdr-client.js";

describe("herdr command adapter", () => {
  it("splits a background pane with the live Herdr split flags", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const split = await herdr.splitCurrent();
    expect(split.stdout.trim()).toBe("pane_abc");
    expect(calls[0]).toEqual([
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--no-focus",
    ]);
  });

  it("passes a working directory with spaces to the split as one argument", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    await herdr.splitCurrent({ cwd: "/tmp/router home/worktrees/wt-1" });
    expect(calls[0]).toEqual([
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/tmp/router home/worktrees/wt-1",
      "--no-focus",
    ]);
  });

  it("starts Cursor in an existing pane with extra agent args after --", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    await herdr.startAgent({
      name: "router-cursor",
      kind: "cursor",
      paneId: "pane_abc",
      agentArgs: ["--model", "cursor-grok-4.6-medium"],
    });
    expect(calls[0]).toEqual([
      "herdr",
      "agent",
      "start",
      "router-cursor",
      "--kind",
      "cursor",
      "--pane",
      "pane_abc",
      "--",
      "--model",
      "cursor-grok-4.6-medium",
    ]);
  });

  it("prompts without resending when the adapter reports a blocked agent", async () => {
    const herdr = createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "agent_blocked",
    }));
    const result = await herdr.prompt({ target: "router-cursor", text: "do the task" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("agent_blocked");
  });

  it("closes a pane by id", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    await herdr.closePane("w1:p9");
    expect(calls).toEqual([["herdr", "pane", "close", "w1:p9"]]);
  });

  it("waits for an agent state with a timeout", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    await herdr.waitFor({ target: "router-codex-abc123", timeoutMs: 30000 });
    await herdr.prompt({
      target: "router-codex-abc123",
      text: "task",
      until: ["working", "blocked"],
      timeoutMs: 5000,
    });
    expect(calls).toEqual([
      ["herdr", "agent", "wait", "router-codex-abc123", "--timeout", "30000"],
      [
        "herdr",
        "agent",
        "prompt",
        "router-codex-abc123",
        "task",
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "5000",
      ],
    ]);
  });

  it("passes only the explicit child environment to a real process", async () => {
    const run = createProcessCommandAdapter({
      env: { PATH: process.env.PATH, SAFE_VALUE: "kept" },
    });
    const result = await run([
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({safe:process.env.SAFE_VALUE,secret:process.env.ROUTER_TEST_SECRET}))",
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ safe: "kept" });
  });
});
