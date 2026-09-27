import { describe, expect, it, vi } from "vitest";
import type { RouterSession } from "../../src/domain/session.js";
import type { CommandResult, HerdrClient } from "../../src/launch/herdr-client.js";
import { continueInPlace, inheritTopTier, planInPlace } from "../../src/live-effort/in-place.js";
import { FakePane, noSleep } from "./fake-pane.js";
import { launchedSession, opusAccount, opusModel, store } from "./fixtures.js";

const OK: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" };
const FAILED: CommandResult = { ok: false, code: 1, stdout: "", stderr: "timeout" };

function plan(overrides: Partial<Parameters<typeof planInPlace>[0]> = {}) {
  return planInPlace({
    enabled: true,
    previous: launchedSession({ agent: "claude-code", effort: "medium" }),
    accountId: opusAccount.id,
    modelId: opusModel.id,
    effort: "high",
    creatingWorktree: false,
    env: {},
    ...overrides,
  });
}

/** `waitFor` is the idle wait; `confirm` answers the post-prompt wait for working/blocked. */
function herdr(input: {
  waitFor?: CommandResult;
  prompt?: CommandResult;
  confirm?: CommandResult;
}) {
  return {
    splitCurrent: vi.fn(async () => OK),
    startAgent: vi.fn(async () => OK),
    prompt: vi.fn(async () => input.prompt ?? OK),
    waitFor: vi.fn(async (call: Parameters<HerdrClient["waitFor"]>[0]) =>
      call.until?.includes("working") ? (input.confirm ?? OK) : (input.waitFor ?? OK),
    ),
    closePane: vi.fn(async () => OK),
  } satisfies HerdrClient;
}

describe("planInPlace", () => {
  it("names every new-pane reason, and plans from the pane's live level", () => {
    const session = launchedSession({ agent: "claude-code", effort: "medium" });
    const route = session.route!;
    const cases: [Partial<Parameters<typeof planInPlace>[0]>, string][] = [
      [{ enabled: false }, "disabled"],
      [{ previous: undefined }, "no-live-pane"],
      [{ previous: { ...session, route: { ...route, status: "launch-failed" } } }, "no-live-pane"],
      [{ previous: { ...session, paneId: undefined } }, "no-live-pane"],
      [{ previous: { ...session, route: { ...route, agentName: undefined } } }, "no-live-pane"],
      [{ accountId: "acct_other" }, "different-route"],
      [
        {
          modelId: "anthropic:claude-sonnet",
          previous: { ...session, route: { ...route, modelId: "anthropic:claude-sonnet" } },
        },
        "model-not-live",
      ],
      [{ previous: { ...session, liveSwitchUnsupported: true } }, "unsupported"],
      [{ creatingWorktree: true }, "new-worktree"],
      [{ effort: "max" }, "top-tier-requires-new-pane"],
    ];
    for (const [overrides, reason] of cases) {
      expect(plan(overrides), reason).toEqual({ ok: false, reason });
    }
    // It starts from the live level, and a top-tier pane may continue at its own level.
    const topTier = launchedSession({
      agent: "claude-code",
      effort: "max",
      extras: { liveEffort: "max" },
    });
    expect(
      plan({ previous: topTier, effort: "max", env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1" } }),
    ).toEqual({
      ok: true,
      plan: {
        paneId: "wJ:p1",
        agentName: "router-claude-abc123",
        agent: "claude-code",
        from: "max",
        to: "max",
        callerIsTarget: true,
      },
    });
    const switched = launchedSession({
      agent: "claude-code",
      effort: "medium",
      extras: { liveEffort: "low" },
    });
    expect(plan({ previous: switched })).toMatchObject({ ok: true, plan: { from: "low" } });
  });
});

describe("continueInPlace failures", () => {
  it("stops on a held lock, an agent that never goes idle, or an unconfirmed prompt", async () => {
    const { effortChanges } = store();
    const ready = plan();
    if (!ready.ok) throw new Error("expected a plan");
    const same = { ...ready.plan, to: ready.plan.from };
    const run = (client: HerdrClient, pane = new FakePane({ agent: "claude", level: "medium" })) =>
      continueInPlace({
        plan: same,
        handoffPrompt: "Next phase",
        herdr: client,
        pane,
        effortChanges,
        callerEnv: {},
        sleep: noSleep,
        switchTimeoutMs: 100,
      });

    // The lock outlives a long hold: another caller 90 s in still cannot take it.
    const longHold = herdr({});
    let stolen: boolean | undefined;
    longHold.waitFor.mockImplementationOnce(async () => {
      stolen = effortChanges.tryLock("wJ:p1", "thief", Date.now() + 90_000, 60_000);
      return OK;
    });
    await run(longHold);
    expect(stolen).toBe(false);

    effortChanges.tryLock("wJ:p1", "other", Date.now(), 60_000);
    const locked = herdr({});
    expect(await run(locked)).toEqual({ ok: false, reason: "switch-in-progress" });
    expect(locked.waitFor).not.toHaveBeenCalled();
    effortChanges.unlock("wJ:p1", "other");

    const busy = herdr({ waitFor: FAILED });
    expect(await run(busy)).toEqual({ ok: false, reason: "pane-busy" });
    expect(busy.prompt).not.toHaveBeenCalled();

    // A prompt whose wait timed out but whose turn then started was delivered.
    const slow = herdr({ prompt: FAILED });
    expect(await run(slow)).toMatchObject({ ok: true });

    // Unconfirmed either way: it may have been delivered, so no new pane may follow.
    const unconfirmed = herdr({ prompt: FAILED, confirm: FAILED });
    expect(await run(unconfirmed)).toMatchObject({
      ok: false,
      reason: "prompt-unconfirmed",
      noFallback: true,
    });

    // An unconfirmed prompt after a switch still reports the switch, so it is recorded.
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const afterSwitch = await continueInPlace({
      plan: ready.plan,
      handoffPrompt: "Next phase",
      herdr: herdr({ prompt: FAILED, confirm: FAILED }),
      pane,
      effortChanges,
      callerEnv: {},
      sleep: noSleep,
      switchTimeoutMs: 100,
    });
    expect(afterSwitch).toMatchObject({
      ok: false,
      reason: "prompt-unconfirmed",
      switched: { status: "applied", to: "high" },
    });
    // Every path released the lock.
    expect(effortChanges.tryLock("wJ:p1", "next", Date.now(), 60_000)).toBe(true);
  });
});

describe("continueInPlace ownership", () => {
  const setupPlan = () => {
    const ready = planInPlace({
      enabled: true,
      previous: launchedSession({ agent: "claude-code", effort: "medium" }),
      accountId: "acct_claude",
      modelId: "anthropic:claude-opus",
      effort: "medium",
      creatingWorktree: false,
      env: { HERDR_PANE_ID: "wJ:p5" },
    });
    if (!ready.ok) throw new Error("expected a plan");
    return ready.plan;
  };

  it("stops when another phase took the pane while it waited for the lock", async () => {
    const { effortChanges } = store();
    const client = herdr({});
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const result = await continueInPlace({
      plan: setupPlan(),
      handoffPrompt: "Next phase",
      herdr: client,
      pane,
      effortChanges,
      stillCurrent: () => false,
      callerEnv: {},
      sleep: noSleep,
      switchTimeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, reason: "superseded-session" });
    expect(client.waitFor).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(pane.keys).toEqual([]);
    expect(effortChanges.tryLock("wJ:p1", "next", Date.now(), 60_000)).toBe(true);
  });

  it("keeps the pane locked until the caller has recorded the phase", async () => {
    const { effortChanges } = store();
    const result = await continueInPlace({
      plan: setupPlan(),
      handoffPrompt: "Next phase",
      herdr: herdr({}),
      pane: new FakePane({ agent: "claude", level: "medium" }),
      effortChanges,
      stillCurrent: () => true,
      holdLock: true,
      callerEnv: {},
      sleep: noSleep,
      switchTimeoutMs: 100,
    });
    expect(result.ok).toBe(true);
    expect(effortChanges.tryLock("wJ:p1", "other", Date.now(), 60_000)).toBe(false);
    result.release?.();
    expect(effortChanges.tryLock("wJ:p1", "other", Date.now(), 60_000)).toBe(true);
  });
});

describe("inheritTopTier", () => {
  it("walks a legacy chain to the root task, and prefers a recorded flag", () => {
    const at = (id: string, task: string, extras: Partial<RouterSession> = {}) =>
      launchedSession({ id, agent: "claude-code", effort: "medium", task, extras });
    const root = at("sess_root", "Plan it with ultra care.");
    const middle = at("sess_mid", "Implement it.", { previousSessionId: "sess_root" });
    const last = at("sess_last", "Review it.", { previousSessionId: "sess_mid" });
    const byId = new Map([root, middle, last].map((session) => [session.id, session]));
    const get = (id: string) => byId.get(id);

    expect(inheritTopTier(last, get)).toBe(true);
    // A recorded flag wins over the root task.
    byId.set("sess_mid", { ...middle, topTierUnlocked: false });
    expect(inheritTopTier(last, get)).toBe(false);
    // A continued task that says "ultra" never unlocks by itself.
    const plainRoot = at("sess_root", "Plan it.");
    byId.set("sess_root", plainRoot);
    byId.set("sess_mid", { ...middle, task: "Implement it with ultra effort." });
    expect(inheritTopTier(last, get)).toBe(false);
    // A broken chain stays locked.
    expect(inheritTopTier(at("sess_orphan", "x", { previousSessionId: "sess_gone" }), get)).toBe(
      false,
    );
  });
});
