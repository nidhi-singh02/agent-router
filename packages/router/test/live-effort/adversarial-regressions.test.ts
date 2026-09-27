import { describe, expect, it } from "vitest";
import { executeEffort, type EffortDeps } from "../../src/commands/effort.js";
import type { HerdrPaneClient } from "../../src/launch/herdr-client.js";
import { switchEffort, type SwitchInput } from "../../src/live-effort/switcher.js";
import { FakePane, noSleep } from "./fake-pane.js";
import { effortTypeSafe, launchedSession, opusAccount, opusModel, store } from "./fixtures.js";

function wrap(fake: FakePane, overrides: Partial<HerdrPaneClient> = {}): HerdrPaneClient {
  return {
    getAgent: (target) => fake.getAgent(target),
    readPane: (paneId, options) => fake.readPane(paneId, options),
    sendKeys: (paneId, keys) => fake.sendKeys(paneId, keys),
    sendText: (paneId, text) => fake.sendText(paneId, text),
    ...overrides,
  };
}

function input(pane: FakePane, overrides: Partial<SwitchInput> = {}): SwitchInput {
  return {
    agent: "claude-code",
    paneId: pane.paneId,
    agentName: pane.agentName,
    from: "medium",
    to: "high",
    callerIsTarget: false,
    callerEnv: {},
    ...overrides,
  };
}

const deps = (pane: HerdrPaneClient) => ({ pane, sleep: noSleep, timeoutMs: 100, pollMs: 10 });

describe("adversarial review regressions", () => {
  it("drives the slider when only the record says the pane is at the target", async () => {
    // An earlier unconfirmed switch left the pane at low while the record says high.
    const pane = new FakePane({ agent: "claude", level: "low" });
    const result = await switchEffort(input(pane, { from: "high", to: "high" }), deps(pane));
    expect(result).toMatchObject({ status: "applied", to: "high" });
    expect(pane.level).toBe("high");
  });

  it("never presses Enter unless the box holds exactly /effort", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    // The user starts typing just as the router types.
    const racing = wrap(pane, {
      sendText: async (paneId, text) => {
        pane.draft = "hi";
        return pane.sendText(paneId, text);
      },
    });
    const result = await switchEffort(input(pane), deps(racing));
    expect(result).toMatchObject({ status: "failed", reason: "pane-input-busy" });
    expect(pane.keys).not.toContain("enter");
  });

  it("types nothing without a baseline read of the pane", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    let reads = 0;
    const flaky = wrap(pane, {
      readPane: async (paneId, options) =>
        options.source === "recent" && reads++ === 0 ? undefined : pane.readPane(paneId, options),
    });
    const result = await switchEffort(input(pane), deps(flaky));
    expect(result).toMatchObject({ status: "failed", reason: "send-failed" });
    expect(pane.texts).toEqual([]);
  });

  it("counts Kept at the target level as already there", async () => {
    const pane = new FakePane({ agent: "claude", level: "high" });
    const keeps = wrap(pane, {
      sendKeys: async (paneId, keys) => {
        if (keys.includes("s")) {
          pane.sliderOpen = false;
          pane.recent.push("  ⎿  Kept effort level as high");
          return { ok: true, code: 0, stdout: "", stderr: "" };
        }
        return pane.sendKeys(paneId, keys);
      },
    });
    const result = await switchEffort(input(pane, { from: "medium" }), deps(keeps));
    expect(result).toEqual({
      status: "no-change",
      from: "high",
      to: "high",
      reason: "already-at-level",
    });
  });

  it("declines a cache-warning dialog that appears after the wait", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    let readsAfterS: number | undefined;
    const late = wrap(pane, {
      sendKeys: async (paneId, keys) => {
        if (keys.includes("s")) {
          pane.sliderOpen = false;
          readsAfterS = 0;
          return { ok: true, code: 0, stdout: "", stderr: "" };
        }
        return pane.sendKeys(paneId, keys);
      },
      readPane: async (paneId, options) => {
        const screen = await pane.readPane(paneId, options);
        if (readsAfterS === undefined) return screen;
        readsAfterS += 1;
        // The outcome wait reads twice and sees nothing; the dialog is up by the last look.
        return readsAfterS > 2
          ? `${screen}\nChange effort level?\n  1. Yes\n  2. No, go back`
          : screen;
      },
    });
    const result = await switchEffort(input(pane), {
      pane: late,
      sleep: noSleep,
      timeoutMs: 10,
      pollMs: 10,
    });
    expect(result).toMatchObject({ status: "failed", reason: "cache-warning", unsupported: true });
    expect(pane.keys.at(-1)).toBe("esc");
  });

  it("runs the cooldown from a failed attempt too", async () => {
    const { sessions, effortChanges } = store();
    sessions.save(launchedSession({ agent: "claude-code", effort: "medium" }));
    const now = new Date("2026-09-26T10:00:00.000Z");
    effortChanges.record({
      sessionId: "sess_live",
      source: "agent",
      from: "medium",
      to: "high",
      status: "failed",
      reason: "verify-timeout",
      turnBreak: false,
      createdAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    const client = effortTypeSafe("high");
    const depsForEffort: EffortDeps = {
      sessions,
      effortChanges,
      pane: new FakePane({ agent: "claude", level: "medium" }),
      client,
      accounts: [opusAccount],
      models: [opusModel],
      usage: {},
      env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1", CLAUDE_EFFORT: "medium" },
      liveEffortEnabled: true,
      now: () => now,
      sleep: noSleep,
    };
    const result = await executeEffort(
      "sess_live",
      { kind: "agent", subStep: "Retry the switch", signals: {} },
      depsForEffort,
    );
    expect(result).toMatchObject({ code: 4, json: { reason: "cooldown" } });
    expect(client.calls).toHaveLength(0);
  });
});
