import { describe, expect, it } from "vitest";
import type { CommandResult, HerdrPaneClient } from "../../src/launch/herdr-client.js";
import { switchEffort, type SwitchInput } from "../../src/live-effort/switcher.js";
import { FakePane, noSleep } from "./fake-pane.js";

const OK: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" };
const FAILED: CommandResult = { ok: false, code: 1, stdout: "", stderr: "herdr: pane gone" };

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

/** The fake pane with some of its Herdr calls replaced. */
function wrap(fake: FakePane, overrides: Partial<HerdrPaneClient> = {}): HerdrPaneClient {
  return {
    getAgent: (target) => fake.getAgent(target),
    readPane: (paneId, options) => fake.readPane(paneId, options),
    sendKeys: (paneId, keys) => fake.sendKeys(paneId, keys),
    sendText: (paneId, text) => fake.sendText(paneId, text),
    ...overrides,
  };
}

const deps = (pane: HerdrPaneClient) => ({ pane, sleep: noSleep, timeoutMs: 100, pollMs: 10 });

describe("switchEffort guards", () => {
  it("treats an agent of the wrong kind, or an unreadable pane, as drift", async () => {
    const claude = new FakePane({ agent: "claude", level: "medium" });
    const wrongKind = await switchEffort(input(claude, { agent: "codex" }), deps(wrap(claude)));
    expect(wrongKind).toMatchObject({ status: "failed", reason: "pane-drift" });

    const unreadable = await switchEffort(
      input(claude),
      deps(wrap(claude, { readPane: async () => undefined })),
    );
    expect(unreadable).toMatchObject({ status: "failed", reason: "pane-drift" });
    expect(claude.keys).toEqual([]);
    expect(claude.texts).toEqual([]);
  });

  it("fails closed when no input line is on screen", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const result = await switchEffort(
      input(pane),
      deps(wrap(pane, { readPane: async () => "  Working… (esc to interrupt)" })),
    );
    expect(result).toMatchObject({ status: "failed", reason: "pane-input-busy" });
    expect(pane.keys).toEqual([]);
  });
});

describe("switchEffort on Claude Code, failure paths", () => {
  it("reports send-failed and sends nothing more when /effort cannot be typed", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const result = await switchEffort(
      input(pane),
      deps(wrap(pane, { sendText: async () => FAILED })),
    );
    expect(result).toMatchObject({ status: "failed", reason: "send-failed" });
    expect(pane.keys).toEqual([]);
  });

  it("reports verify-timeout when the slider opens but no outcome appears", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const swallowS = wrap(pane, {
      sendKeys: (paneId, keys) =>
        pane.sendKeys(
          paneId,
          keys.filter((key) => key !== "s"),
        ),
    });
    const result = await switchEffort(input(pane), deps(swallowS));
    expect(result).toMatchObject({ status: "failed", reason: "verify-timeout" });
    expect(pane.level).toBe("medium");
  });

  it("maps each non-applied /effort outcome to a failure without accepting anything", async () => {
    const cases: [string, string][] = [
      ["  ⎿  Set effort level to high (saved as your default for new sessions)", "saved-default"],
      ["  ⎿  Effort xhigh exceeds the cap for this organization", "effort-capped"],
      ["  ⎿  Kept effort level as medium", "verify-mismatch"],
      ["  ⎿  Set effort level to low (this session only): details", "verify-mismatch"],
    ];
    for (const [line, reason] of cases) {
      const pane = new FakePane({ agent: "claude", level: "medium" });
      const scripted = wrap(pane, {
        async sendKeys(paneId, keys) {
          if (keys.at(-1) !== "s") return pane.sendKeys(paneId, keys);
          await pane.sendKeys(paneId, keys.slice(0, -1));
          pane.sliderOpen = false;
          pane.recent.push(line);
          return OK;
        },
      });
      const result = await switchEffort(input(pane), deps(scripted));
      expect(result, line).toEqual({ status: "failed", from: "medium", to: "high", reason });
      expect(pane.keys, line).not.toContain("esc");
    }
  });

  it("switches from the router's record, not a lagging readback, for a non-calling pane", async () => {
    // The router switched this idle pane to low; nothing since has run at the new level.
    const pane = new FakePane({ agent: "claude", level: "low" });
    const result = await switchEffort(input(pane, { from: "low", to: "high" }), deps(pane));
    expect(result).toMatchObject({ status: "applied", from: "low", to: "high" });
    expect(pane.level).toBe("high");
  });
});

describe("switchEffort on Codex, failure paths", () => {
  it("attempts nothing without the status line, since it could not confirm the switch", async () => {
    const pane = new FakePane({ agent: "codex", level: "medium" });
    const noStatus = wrap(pane, {
      readPane: async (paneId, options) =>
        (await pane.readPane(paneId, options))?.replace(/GPT-6-Astra \w+/, ""),
    });
    const result = await switchEffort(input(pane), deps(noStatus));
    expect(result).toMatchObject({ status: "failed", reason: "verify-timeout" });
    expect(pane.keys).toEqual([]);
  });

  it("reports no-change when the status line already shows the level", async () => {
    const pane = new FakePane({ agent: "codex", level: "high" });
    const result = await switchEffort(input(pane, { from: "low", to: "high" }), deps(wrap(pane)));
    expect(result).toEqual({
      status: "no-change",
      from: "high",
      to: "high",
      reason: "already-at-level",
    });
    expect(pane.keys).toEqual([]);
  });

  it("retries a burst that changed nothing, but never one that partly landed", async () => {
    // Nothing moved: resending cannot overshoot.
    const dropped = new FakePane({ agent: "codex", level: "low" });
    const dropCalls: string[][] = [];
    const dropsFirst = wrap(dropped, {
      sendKeys: (paneId, keys) => {
        dropCalls.push([...keys]);
        return dropped.sendKeys(paneId, dropCalls.length === 1 ? [] : keys);
      },
    });
    expect(await switchEffort(input(dropped, { to: "high" }), deps(dropsFirst))).toEqual({
      status: "applied",
      from: "low",
      to: "high",
      turnBreak: false,
    });
    expect(dropCalls).toEqual([
      ["alt+.", "alt+."],
      ["alt+.", "alt+."],
    ]);

    // Partly landed: the rest may still arrive, so resending could overshoot.
    const partial = new FakePane({ agent: "codex", level: "low" });
    const partCalls: string[][] = [];
    const landsOne = wrap(partial, {
      sendKeys: (paneId, keys) => {
        partCalls.push([...keys]);
        return partial.sendKeys(paneId, keys.slice(0, 1));
      },
    });
    expect(await switchEffort(input(partial, { to: "high" }), deps(landsOne))).toMatchObject({
      status: "failed",
      reason: "verify-mismatch",
    });
    expect(partCalls).toHaveLength(1);
  });

  it("reports send-failed when the shortcut or the queued continuation cannot be sent", async () => {
    const idle = new FakePane({ agent: "codex", level: "medium" });
    const keysFail = await switchEffort(
      input(idle),
      deps(wrap(idle, { sendKeys: async () => FAILED })),
    );
    expect(keysFail).toMatchObject({ status: "failed", reason: "send-failed" });

    const working = new FakePane({ agent: "codex", level: "medium", status: "working" });
    const textFails = await switchEffort(
      input(working, { continuation: "Continue with the sub-step: next" }),
      deps(wrap(working, { sendText: async () => FAILED })),
    );
    // The level did change, so it is reported applied, without a turn break: nothing was
    // queued, so the agent carries on itself and no second pane takes the task.
    expect(textFails).toEqual({ status: "applied", from: "medium", to: "high", turnBreak: false });
    expect(working.level).toBe("high");
    expect(working.keys).not.toContain("tab");
    expect(working.queued).toEqual([]);
  });
});
