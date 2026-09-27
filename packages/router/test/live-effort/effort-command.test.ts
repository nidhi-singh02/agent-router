import { describe, expect, it } from "vitest";
import { executeEffort, type EffortDeps } from "../../src/commands/effort.js";
import { AccountSchema } from "../../src/domain/account.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
import { FakePane, noSleep } from "./fake-pane.js";
import {
  astraAccount,
  astraModel,
  effortTypeSafe,
  launchedSession,
  opusAccount,
  opusModel,
  store,
} from "./fixtures.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");

function setup(options: {
  agent?: "claude-code" | "codex";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  paneStatus?: "idle" | "working";
  choice?: string;
  confidence?: number;
  enabled?: boolean;
  extras?: Parameters<typeof launchedSession>[0]["extras"];
  deps?: Partial<EffortDeps>;
}) {
  const agent = options.agent ?? "claude-code";
  const effort = options.effort ?? "medium";
  const { sessions, effortChanges } = store();
  const session = launchedSession({ agent, effort, extras: options.extras });
  sessions.save(session);
  const pane = new FakePane({
    agent: agent === "claude-code" ? "claude" : "codex",
    level: effort,
    status: options.paneStatus ?? (agent === "codex" ? "working" : "idle"),
  });
  const client = effortTypeSafe(options.choice ?? "high", options.confidence ?? 0.9);
  const deps: EffortDeps = {
    sessions,
    effortChanges,
    pane,
    client,
    accounts: [opusAccount, astraAccount],
    models: [opusModel, astraModel],
    usage: {},
    // Claude Code sets CLAUDE_EFFORT for its tools: the calling agent reports its own level.
    env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1", CLAUDE_EFFORT: effort },
    liveEffortEnabled: options.enabled ?? true,
    now: () => NOW,
    sleep: noSleep,
    switchTimeoutMs: 100,
    ...options.deps,
  };
  return { session, sessions, effortChanges, pane, client, deps };
}

const agentRequest = {
  kind: "agent" as const,
  subStep: "Debug the failing migration test",
  signals: {},
};

describe("router effort (agent sub-step)", () => {
  it("asks TypeSafe, switches the pane, and records the change", async () => {
    const { deps, pane, sessions, effortChanges, client } = setup({ choice: "xhigh" });
    const result = await executeEffort(
      "sess_live",
      { ...agentRequest, signals: { stepKind: "debug", consecutiveFailures: 4, diffLines: 420 } },
      deps,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Continue at xhigh.");
    expect(result.json).toMatchObject({
      from: "medium",
      to: "xhigh",
      status: "applied",
      turnBreak: false,
    });
    expect(pane.level).toBe("xhigh");
    expect(sessions.get("sess_live")?.liveEffort).toBe("xhigh");
    const [change] = effortChanges.listForSession("sess_live");
    expect(change).toMatchObject({
      source: "agent",
      from: "medium",
      to: "xhigh",
      status: "applied",
      confidence: 0.9,
      signals: { stepKind: "debug", consecutiveFailures: "3+", diffLines: "300-1000" },
    });
    // TypeSafe sees buckets, never raw counts, and never a top-tier choice.
    const state = client.calls[0]!.state as { signals: Record<string, unknown> };
    expect(state.signals).toEqual({
      stepKind: "debug",
      consecutiveFailures: "3+",
      diffLines: "300-1000",
    });
    const criteria = Object.keys(
      (client.calls[0]!.questions.effort as { criteria: Record<string, string> }).criteria,
    );
    expect(criteria).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("tells a Codex agent to end its turn and queues the sub-step", async () => {
    const { deps, pane } = setup({ agent: "codex", choice: "high" });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result.code).toBe(0);
    expect(result.output).toContain("End your turn now");
    expect(result.json).toMatchObject({ turnBreak: true });
    expect(pane.queued).toEqual(["Continue with the sub-step: Debug the failing migration test"]);
  });

  it("does nothing when the feature is disabled", async () => {
    const { deps, client, pane } = setup({ enabled: false });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "disabled" } });
    expect(client.calls).toHaveLength(0);
    expect(pane.keys).toHaveLength(0);
  });

  it("does nothing for a model that cannot switch in place", async () => {
    const { deps } = setup({
      extras: {
        route: {
          ...launchedSession({ agent: "claude-code", effort: "medium" }).route!,
          modelId: "anthropic:claude-sonnet",
        },
      },
    });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "not-eligible" } });
  });

  it("keeps the level without keystrokes when TypeSafe picks the current one", async () => {
    const { deps, pane } = setup({ choice: "medium" });
    const result = await executeEffort("sess_live", agentRequest, deps);
    // The switcher still reads the pane back; it agrees, so nothing is typed.
    expect(result).toMatchObject({ code: 4, json: { reason: "already-at-level" } });
    expect(pane.keys).toHaveLength(0);
  });

  it("keeps the level when TypeSafe is not confident", async () => {
    const { deps, pane } = setup({ choice: "high", confidence: 0.55 });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "low-confidence", to: "high" } });
    expect(pane.keys).toHaveLength(0);
  });

  it("enforces the cooldown between agent switches", async () => {
    const { deps, effortChanges, client } = setup({});
    effortChanges.record({
      sessionId: "sess_live",
      source: "agent",
      from: "low",
      to: "medium",
      status: "applied",
      reason: "switched",
      turnBreak: false,
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "cooldown" } });
    expect(client.calls).toHaveLength(0);
  });

  it("caps agent switches per session", async () => {
    const { deps, effortChanges } = setup({});
    for (let index = 0; index < 8; index += 1) {
      effortChanges.record({
        sessionId: "sess_live",
        source: "agent",
        from: "low",
        to: "medium",
        status: "applied",
        reason: "switched",
        turnBreak: false,
        createdAt: new Date(NOW.getTime() - (index + 1) * 3_600_000).toISOString(),
      });
    }
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "switch-cap" } });
  });

  it("blocks raising effort on a shared account below its reserve, but allows lowering", async () => {
    const shared = AccountSchema.parse({ ...opusAccount, ownership: "shared", reserveFloor: 0.4 });
    const usage = UsageSnapshotSchema.parse({
      accountId: shared.id,
      windows: [{ kind: "five-hour", remainingRatio: 0.41, usedRatio: 0.59 }],
      collectedAt: "2026-09-26T09:59:00.000Z",
      source: "local-session",
      certainty: "exact",
      expiresAt: "2026-09-26T10:10:00.000Z",
      activeReservationRatio: 0,
    });
    const up = setup({
      choice: "high",
      deps: { accounts: [shared], usage: { [shared.id]: usage } },
    });
    expect(await executeEffort("sess_live", agentRequest, up.deps)).toMatchObject({
      code: 4,
      json: { reason: "quota" },
    });
    const down = setup({
      choice: "low",
      deps: { accounts: [shared], usage: { [shared.id]: usage } },
    });
    expect(await executeEffort("sess_live", agentRequest, down.deps)).toMatchObject({ code: 0 });
  });

  it("skips a chain the agent already refused", async () => {
    const { deps } = setup({ extras: { liveSwitchUnsupported: true } });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "unsupported" } });
  });

  it("marks the session unsupported when the agent shows the cache-warning dialog", async () => {
    const { deps, sessions, session } = setup({ choice: "high" });
    const pane = new FakePane({ agent: "claude", level: "medium", cacheDialog: true });
    const result = await executeEffort("sess_live", agentRequest, { ...deps, pane });
    expect(result).toMatchObject({ code: 5, json: { reason: "cache-warning" } });
    expect(sessions.get(session.id)?.liveSwitchUnsupported).toBe(true);
  });

  it("fails fast while another switch holds the pane", async () => {
    const { deps, effortChanges } = setup({ choice: "high" });
    effortChanges.tryLock("wJ:p1", "someone-else", Date.now(), 60_000);
    const result = await executeEffort("sess_live", agentRequest, {
      ...deps,
      now: () => new Date(),
    });
    expect(result).toMatchObject({ code: 5, json: { reason: "switch-in-progress" } });
  });

  it("rejects credential-looking sub-step text before TypeSafe", async () => {
    const { deps, client } = setup({});
    const result = await executeEffort(
      "sess_live",
      { ...agentRequest, subStep: "use password=hunter2 for the db" },
      deps,
    );
    expect(result).toMatchObject({ code: 4, json: { reason: "unsafe-state" } });
    expect(client.calls).toHaveLength(0);
  });
});

describe("router effort (manual override)", () => {
  it("switches without TypeSafe and ignores the cooldown", async () => {
    const { deps, client, effortChanges, pane } = setup({});
    effortChanges.record({
      sessionId: "sess_live",
      source: "agent",
      from: "low",
      to: "medium",
      status: "applied",
      reason: "switched",
      turnBreak: false,
      createdAt: NOW.toISOString(),
    });
    const result = await executeEffort("sess_live", { kind: "manual", level: "low" }, deps);
    expect(result.code).toBe(0);
    expect(client.calls).toHaveLength(0);
    expect(pane.level).toBe("low");
    expect(effortChanges.listForSession("sess_live").at(-1)).toMatchObject({ source: "manual" });
  });

  it("sends top-tier levels to a new pane on both models", async () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const { deps } = setup({ agent });
      const result = await executeEffort("sess_live", { kind: "manual", level: "max" }, deps);
      expect(result).toMatchObject({ code: 4, json: { reason: "top-tier-requires-new-pane" } });
    }
  });

  it("rejects a level the model does not support", async () => {
    const { deps } = setup({});
    const result = await executeEffort("sess_live", { kind: "manual", level: "ultra" }, deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "unsupported-effort" } });
  });

  it("reports an unknown session", async () => {
    const { deps } = setup({});
    const result = await executeEffort("sess_missing", { kind: "manual", level: "low" }, deps);
    expect(result.code).toBe(2);
  });
});

describe("router effort (remaining gates)", () => {
  it("keeps the level when TypeSafe fails, picks the top tier, or the level is current", async () => {
    const unavailable = setup({
      deps: {
        client: {
          async systemOne() {
            throw new Error("TypeSafe down");
          },
        },
      },
    });
    expect(await executeEffort("sess_live", agentRequest, unavailable.deps)).toMatchObject({
      code: 4,
      json: { reason: "typesafe-unavailable", from: "medium", to: "medium" },
    });
    expect(unavailable.pane.keys).toHaveLength(0);

    const gated = setup({ choice: "max" });
    expect(await executeEffort("sess_live", agentRequest, gated.deps)).toMatchObject({
      code: 4,
      json: { reason: "top-tier-gated", to: "medium" },
    });
    expect(gated.pane.keys).toHaveLength(0);

    const current = setup({});
    expect(
      await executeEffort("sess_live", { kind: "manual", level: "medium" }, current.deps),
    ).toMatchObject({ code: 4, json: { reason: "already-at-level" } });
    // The pane was read back and agreed: recorded as a no-change, with nothing typed.
    expect(current.effortChanges.listForSession("sess_live")).toMatchObject([
      { status: "no-change", reason: "already-at-level" },
    ]);
    expect(current.pane.keys).toHaveLength(0);

    const noRoute = setup({});
    noRoute.sessions.save({ ...noRoute.session, route: undefined });
    expect(
      await executeEffort("sess_live", { kind: "manual", level: "high" }, noRoute.deps),
    ).toMatchObject({ code: 2, json: { ok: false } });
  });
});
