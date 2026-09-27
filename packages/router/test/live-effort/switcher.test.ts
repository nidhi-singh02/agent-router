import { describe, expect, it } from "vitest";
import { switchEffort, type SwitchInput } from "../../src/live-effort/switcher.js";
import { FakePane, noSleep } from "./fake-pane.js";

function input(pane: FakePane, overrides: Partial<SwitchInput> = {}): SwitchInput {
  return {
    agent: pane.agentName.includes("claude") ? "claude-code" : "codex",
    paneId: pane.paneId,
    agentName: pane.agentName,
    from: pane.level,
    to: "high",
    callerIsTarget: false,
    callerEnv: {},
    ...overrides,
  };
}

const deps = (pane: FakePane) => ({ pane, sleep: noSleep, timeoutMs: 100, pollMs: 10 });

describe("switchEffort on Claude Code", () => {
  it("drives the slider to the level and applies it to this session only", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const result = await switchEffort(input(pane, { to: "xhigh" }), deps(pane));
    expect(result).toEqual({ status: "applied", from: "medium", to: "xhigh", turnBreak: false });
    expect(pane.level).toBe("xhigh");
    expect(pane.texts).toEqual(["/effort"]);
    // Never Enter in the slider: Enter saves the level as the user's default.
    expect(pane.keys.filter((key) => key === "enter")).toHaveLength(1);
    expect(pane.keys.at(-1)).toBe("s");
  });

  it("lowers the level from a higher starting point", async () => {
    const pane = new FakePane({ agent: "claude", level: "xhigh" });
    const result = await switchEffort(input(pane, { to: "low" }), deps(pane));
    expect(result.status).toBe("applied");
    expect(pane.level).toBe("low");
  });

  it("sends nothing after /effort when the slider does not open", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium", sliderBroken: true });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "slider-not-opened" });
    expect(pane.keys).toEqual(["enter"]);
  });

  it("declines the cache-warning dialog and marks the pane unsupported", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium", cacheDialog: true });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toEqual({
      status: "failed",
      from: "medium",
      to: "high",
      reason: "cache-warning",
      unsupported: true,
    });
    expect(pane.keys.at(-1)).toBe("esc");
    expect(pane.level).toBe("medium");
  });

  it("refuses to type into a pane whose input box holds a draft", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium", draft: "lets push this" });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "pane-input-busy" });
    expect(pane.keys).toEqual([]);
    expect(pane.texts).toEqual([]);
  });

  it("uses the calling agent's CLAUDE_EFFORT and skips a switch it does not need", async () => {
    const pane = new FakePane({ agent: "claude", level: "high" });
    const result = await switchEffort(
      input(pane, {
        from: "medium",
        to: "high",
        callerIsTarget: true,
        callerEnv: { CLAUDE_EFFORT: "high" },
      }),
      deps(pane),
    );
    expect(result).toEqual({
      status: "no-change",
      from: "high",
      to: "high",
      reason: "already-at-level",
    });
    expect(pane.keys).toEqual([]);
  });

  it("never switches to a top-tier level in place", async () => {
    const pane = new FakePane({ agent: "claude", level: "high" });
    const result = await switchEffort(input(pane, { to: "max" }), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "top-tier-requires-new-pane" });
    expect(pane.keys).toEqual([]);
  });

  it("stops when the recorded agent is gone or in another pane", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const gone = await switchEffort(input(pane, { agentName: "router-claude-zzzzzz" }), deps(pane));
    expect(gone).toMatchObject({ status: "failed", reason: "pane-drift" });
    const moved = await switchEffort(input(pane, { paneId: "wJ:p9" }), deps(pane));
    expect(moved).toMatchObject({ status: "failed", reason: "pane-drift" });
  });

  it("stops on a blocked pane", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium", status: "blocked" });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "pane-blocked" });
  });
});

describe("switchEffort on Codex", () => {
  it("steps with the reasoning shortcut and confirms on the status line", async () => {
    const pane = new FakePane({ agent: "codex", level: "low" });
    const result = await switchEffort(input(pane, { to: "xhigh" }), deps(pane));
    expect(result).toEqual({ status: "applied", from: "low", to: "xhigh", turnBreak: false });
    expect(pane.keys).toEqual(["alt+.", "alt+.", "alt+."]);
  });

  it("takes its starting level from the status line, not the recorded one", async () => {
    const pane = new FakePane({ agent: "codex", level: "high" });
    const result = await switchEffort(input(pane, { from: "low", to: "medium" }), deps(pane));
    expect(result).toMatchObject({ status: "applied", from: "high", to: "medium" });
    expect(pane.keys).toEqual(["alt+,"]);
  });

  it("queues the continuation mid-turn, since the level applies from the next turn", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium", status: "working" });
    const result = await switchEffort(
      input(pane, { to: "high", continuation: "Continue with the sub-step:\nfix the flaky test" }),
      deps(pane),
    );
    expect(result).toEqual({ status: "applied", from: "medium", to: "high", turnBreak: true });
    expect(pane.queued).toEqual(["Continue with the sub-step: fix the flaky test"]);
    expect(pane.keys.at(-1)).toBe("tab");
  });

  it("does not queue anything on an idle pane", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium" });
    const result = await switchEffort(input(pane, { continuation: "next" }), deps(pane));
    expect(result).toMatchObject({ status: "applied", turnBreak: false });
    expect(pane.texts).toEqual([]);
  });

  it("refuses in Plan mode, where the shortcut changes only the Plan-mode level", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium", planMode: true });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "codex-plan-mode" });
    expect(pane.keys).toEqual([]);
  });

  it("retries once, then reports a mismatch when the status line never changes", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium", ignoreShortcut: true });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "verify-mismatch" });
    expect(pane.keys).toEqual(["alt+.", "alt+."]);
  });

  it("refuses to type over a draft", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium", draft: "half-typed" });
    const result = await switchEffort(input(pane), deps(pane));
    expect(result).toMatchObject({ status: "failed", reason: "pane-input-busy" });
  });
});
