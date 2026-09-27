import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { executeEffort, type EffortDeps } from "../../src/commands/effort.js";
import { executeRun } from "../../src/commands/run.js";
import { AccountSchema } from "../../src/domain/account.js";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
import { buildAgentCommand } from "../../src/launch/agent-command.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { newClaudeOutcome } from "../../src/live-effort/pane-text.js";
import { decideRoute } from "../../src/semantic/decision-engine.js";
import { openDatabase } from "../../src/store/database.js";
import { EffortChangeRepository } from "../../src/store/effort-change-repository.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { fakeTypeSafe, usageFor } from "../cli/fixtures.js";
import { FakePane, noSleep } from "./fake-pane.js";
import { effortTypeSafe, launchedSession, opusAccount, opusModel, store } from "./fixtures.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const agentRequest = { kind: "agent" as const, subStep: "Debug the migration", signals: {} };

function effortSetup(input: {
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  choice?: string;
  pane?: FakePane;
  deps?: Partial<EffortDeps>;
}) {
  const { sessions, effortChanges } = store();
  const effort = input.effort ?? "medium";
  sessions.save(launchedSession({ agent: "claude-code", effort }));
  const pane = input.pane ?? new FakePane({ agent: "claude", level: effort });
  const deps: EffortDeps = {
    sessions,
    effortChanges,
    pane,
    client: effortTypeSafe(input.choice ?? "high"),
    accounts: [opusAccount],
    models: [opusModel],
    usage: {},
    env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1" },
    liveEffortEnabled: true,
    now: () => NOW,
    sleep: noSleep,
    switchTimeoutMs: 100,
    ...input.deps,
  };
  return { deps, sessions, effortChanges, pane };
}

function sharedBelowReserve() {
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
  return { accounts: [shared], usage: { [shared.id]: usage } };
}

describe("review regressions", () => {
  it("treats leaving a top-tier level as lowering, which quota never blocks", async () => {
    const manual = effortSetup({ effort: "max", deps: sharedBelowReserve() });
    expect(
      await executeEffort("sess_live", { kind: "manual", level: "high" }, manual.deps),
    ).toMatchObject({ code: 0, json: { from: "max", to: "high", status: "applied" } });
  });

  it("keeps a top-tier pane there: an agent's sub-step never lowers the user's choice", async () => {
    const agent = effortSetup({ effort: "max", choice: "xhigh" });
    const result = await executeEffort("sess_live", agentRequest, agent.deps);
    expect(result).toMatchObject({ code: 4, json: { reason: "top-tier-held" } });
    expect(agent.pane.keys).toEqual([]);
  });

  it("makes a manual override wait for a held lock, then give up", async () => {
    let t = Date.now();
    const clock = {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    const held = effortSetup({ deps: clock });
    held.effortChanges.tryLock("wJ:p1", "other", t, 600_000);
    expect(
      await executeEffort("sess_live", { kind: "manual", level: "high" }, held.deps),
    ).toMatchObject({ code: 5, json: { reason: "switch-in-progress" } });

    const released = effortSetup({});
    released.effortChanges.tryLock("wJ:p1", "other", t, 600_000);
    const releasing = {
      ...clock,
      sleep: async (ms: number) => {
        t += ms;
        released.effortChanges.unlock("wJ:p1", "other");
      },
    };
    expect(
      await executeEffort(
        "sess_live",
        { kind: "manual", level: "high" },
        { ...released.deps, ...releasing },
      ),
    ).toMatchObject({ code: 0 });
  });

  it("does not spin forever on a held lock when the clock stands still", async () => {
    const { deps, effortChanges } = effortSetup({});
    effortChanges.tryLock("wJ:p1", "other", Date.now(), 600_000);
    const result = await executeEffort("sess_live", { kind: "manual", level: "high" }, deps);
    expect(result).toMatchObject({ code: 5, json: { reason: "switch-in-progress" } });
  });

  it("reads the cooldown and the session only while holding the lock", async () => {
    const { deps, effortChanges, sessions } = effortSetup({ choice: "high" });
    const order: string[] = [];
    const watched: EffortDeps["effortChanges"] = {
      record: (change) => effortChanges.record(change),
      tryLock: (...args) => (order.push("lock"), effortChanges.tryLock(...args)),
      unlock: (...args) => (order.push("unlock"), effortChanges.unlock(...args)),
      agentSwitchStats: (id) => (order.push("cooldown"), effortChanges.agentSwitchStats(id)),
    };
    const watchedSessions: EffortDeps["sessions"] = {
      get: (id) => (order.push("session"), sessions.get(id)),
      save: (session) => sessions.save(session),
      latestForPane: (paneId) => (order.push("pane"), sessions.latestForPane(paneId)),
    };
    const result = await executeEffort("sess_live", agentRequest, {
      ...deps,
      effortChanges: watched,
      sessions: watchedSessions,
    });
    expect(result.code).toBe(0);
    // One early read to find the pane, then the fresh read and cooldown under the lock.
    // The pane's newest session is checked again once the lock is held.
    expect(order).toEqual(["session", "pane", "lock", "pane", "session", "cooldown", "unlock"]);
  });

  it("records a plain failure without touching the session's level", async () => {
    const pane = new FakePane({ agent: "claude", level: "medium", draft: "typing" });
    const { deps, sessions, effortChanges } = effortSetup({ pane });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 5, json: { reason: "pane-input-busy" } });
    expect(effortChanges.listForSession("sess_live").at(-1)).toMatchObject({
      status: "failed",
      reason: "pane-input-busy",
    });
    expect(sessions.get("sess_live")?.liveEffort).toBeUndefined();
    expect(sessions.get("sess_live")?.liveSwitchUnsupported).toBeUndefined();
  });

  it("re-syncs the recorded level when the pane is already at the target", async () => {
    const pane = new FakePane({ agent: "claude", level: "high" });
    const { deps, sessions } = effortSetup({ pane, deps: { env: { CLAUDE_EFFORT: "high" } } });
    const result = await executeEffort(
      "sess_live",
      { kind: "manual", level: "high" },
      // The calling agent's own CLAUDE_EFFORT is trusted only from an agent in that pane.
      { ...deps, env: { CLAUDE_EFFORT: "high", HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1" } },
    );
    expect(result).toMatchObject({ code: 4, json: { reason: "already-at-level" } });
    expect(sessions.get("sess_live")?.liveEffort).toBe("high");
    expect(pane.keys).toEqual([]);
  });

  it("passes the new levels at launch", () => {
    expect(buildAgentCommand({ agent: "claude-code", launchName: "opus", effort: "max" })).toEqual([
      "claude",
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
    expect(
      buildAgentCommand({ agent: "claude-code", launchName: "opus", effort: "xhigh" }).slice(-2),
    ).toEqual(["--effort", "xhigh"]);
    expect(
      buildAgentCommand({ agent: "codex", launchName: "gpt-6-astra", effort: "max" }).slice(-2),
    ).toEqual(["-c", 'model_reasoning_effort="max"']);
  });

  it("rejects a locked top-tier answer from TypeSafe", async () => {
    const decision = await decideRoute({
      task: "Plan the migration",
      topTierUnlocked: false,
      client: fakeTypeSafe({ effort: "max" }),
      candidates: [
        {
          opaqueId: `${opusAccount.id}:${opusModel.id}`,
          agent: "claude-code",
          modelId: opusModel.id,
          supportedEfforts: opusModel.supportedEfforts,
          projectedRemainingRatio: 0.8,
          capabilities: opusModel.capabilities,
        },
      ],
    });
    expect(decision).toEqual({ status: "invalid-choice" });
  });

  it("sees a new identical outcome after an older one scrolled off", () => {
    const message = "⎿  Set effort level to high (this session only): x";
    // The older identical line scrolled out of the window, so the count stays at 2; the new
    // one is recognized by sitting closer to the bottom than the latest one before.
    const before = [message, "work", message, "agent output"].join("\n");
    const after = ["work", message, "agent output", message].join("\n");
    expect(newClaudeOutcome(before, after)).toEqual({ kind: "session-only", level: "high" });
    expect(newClaudeOutcome(before, `${before}\nmore output`)).toBeUndefined();
  });

  it("always includes effortChanges in router session --json", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "router-session-json-"));
    const db = openDatabase({ home });
    new SessionRepository(db).save(launchedSession({ agent: "claude-code", effort: "medium" }));
    db.close();
    const read = async () => {
      let out = "";
      await runCli(["node", "router", "session", "sess_live", "--json"], {
        stdout: { write: (chunk: string) => ((out += chunk), true) },
        stderr: { write: () => true },
        env: { MODEL_ROUTER_HOME: home },
      });
      return JSON.parse(out) as { effortChanges: unknown[] };
    };
    expect((await read()).effortChanges).toEqual([]);
    const db2 = openDatabase({ home });
    new EffortChangeRepository(db2).record({
      sessionId: "sess_live",
      source: "manual",
      from: "medium",
      to: "high",
      status: "applied",
      reason: "switched",
      turnBreak: false,
      createdAt: NOW.toISOString(),
    });
    db2.close();
    expect((await read()).effortChanges).toMatchObject([{ from: "medium", to: "high" }]);
  });

  it("never opens a second pane for a handoff it could not confirm, and records the switch", async () => {
    const { sessions, effortChanges } = store();
    sessions.save(
      launchedSession({
        id: "sess_prev",
        agent: "claude-code",
        effort: "medium",
        phase: "planning",
      }),
    );
    const pane = new FakePane({ agent: "claude", level: "medium" });
    const reservations = new ReservationService();
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      const unconfirmed = argv[2] === "prompt" || (argv[2] === "wait" && argv.includes("working"));
      return unconfirmed
        ? { ok: false, code: 1, stdout: "", stderr: "timeout" }
        : { ok: true, code: 0, stdout: "wJ:p7\n", stderr: "" };
    });
    const result = await executeRun(
      "Implement the plan in docs/plans/x.md",
      { dryRun: false, previousSessionId: "sess_prev" },
      {
        accounts: [opusAccount],
        models: [opusModel],
        usage: { [opusAccount.id]: usageFor(opusAccount.id, 0.8) },
        client: fakeTypeSafe({
          phase: "implementation",
          route: `${opusAccount.id}:${opusModel.id}`,
          effort: "high",
        }),
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "wJ:p5" },
        now: new Date("2026-09-17T09:01:00.000Z"),
        herdr,
        herdrPane: pane,
        sessions,
        effortChanges,
        reservations,
        liveEffortEnabled: true,
        sleep: noSleep,
        switchTimeoutMs: 100,
      },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not confirm it started");
    expect(calls.some((argv) => argv[1] === "pane" && argv[2] === "split")).toBe(false);
    const json = result.json as { sessionId: string };
    // It most likely reached the pane, so the session stays usable by the agent there.
    expect(sessions.get(json.sessionId)).toMatchObject({
      paneId: "wJ:p1",
      continuation: "in-place",
      route: { status: "launched" },
    });
    expect(result.output).toContain("handoff sent but not confirmed");
    // The phase may be running in the old pane, so its quota stays reserved.
    expect(reservations.activeRatio(opusAccount.id)).toBeGreaterThan(0);
    expect((result.json as { continuation: unknown }).continuation).toMatchObject({
      mode: "in-place",
      unconfirmed: true,
    });
    expect(pane.level).toBe("high");
    // The new session now owns the pane, so the switch and the level are recorded there.
    expect(sessions.get(json.sessionId)?.liveEffort).toBe("high");
    expect(effortChanges.listForSession(json.sessionId)).toMatchObject([
      { source: "phase-boundary", to: "high", status: "applied" },
    ]);
  });
});
