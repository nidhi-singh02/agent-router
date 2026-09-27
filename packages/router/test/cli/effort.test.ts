import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import type { EffortDeps } from "../../src/commands/effort.js";

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const effort = vi.fn(async () => ({ code: 0, output: "Continue at high.", json: { ok: true } }));
  const code = await runCli(["node", "router", "effort", ...args], {
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: (chunk: string) => ((err += chunk), true) },
    env: {},
    effort,
    effortDeps: {} as EffortDeps,
  });
  return { code, out, err, effort };
}

describe("router effort", () => {
  it("passes an agent sub-step with its signals", async () => {
    const { code, effort, out } = await cli([
      "--session",
      "sess_1",
      "Debug the flaky test",
      "--step-kind",
      "debug",
      "--consecutive-failures",
      "3",
      "--tests-failing",
      "--diff-lines",
      "120",
    ]);
    expect(code).toBe(0);
    expect(out).toBe("Continue at high.\n");
    expect(effort).toHaveBeenCalledWith(
      "sess_1",
      {
        kind: "agent",
        subStep: "Debug the flaky test",
        signals: { stepKind: "debug", consecutiveFailures: 3, testsFailing: true, diffLines: 120 },
      },
      {},
    );
  });

  it("passes a manual level", async () => {
    const { effort } = await cli(["sess_1", "xhigh"]);
    expect(effort).toHaveBeenCalledWith("sess_1", { kind: "manual", level: "xhigh" }, {});
  });

  it("rejects a missing or unknown level, and a bad signal", async () => {
    expect((await cli(["sess_1"])).code).toBe(1);
    expect((await cli(["sess_1", "turbo"])).code).toBe(1);
    const badKind = await cli(["--session", "sess_1", "step", "--step-kind", "nap"]);
    expect(badKind.code).toBe(1);
    expect(badKind.effort).not.toHaveBeenCalled();
    const badCount = await cli(["--session", "sess_1", "step", "--diff-lines", "-4"]);
    expect(badCount.code).toBe(1);
  });

  it("rejects mixing --session with a level", async () => {
    const { code, err } = await cli(["--session", "sess_1", "step", "high"]);
    expect(code).toBe(1);
    expect(err).toContain("either --session");
  });
});
