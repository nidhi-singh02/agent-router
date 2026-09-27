import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
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
const agentRequest = { kind: "agent" as const, subStep: "Debug the lock", signals: {} };

function setup(input: {
  agent?: "claude-code" | "codex";
  record?: "low" | "medium" | "high" | "xhigh";
  paneLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  choice?: string;
  deps?: Partial<EffortDeps>;
}) {
  const agent = input.agent ?? "claude-code";
  const { sessions, effortChanges } = store();
  sessions.save(launchedSession({ agent, effort: input.record ?? "high" }));
  const pane = new FakePane({
    agent: agent === "claude-code" ? "claude" : "codex",
    level: input.paneLevel ?? input.record ?? "high",
    status: "working",
  });
  const deps: EffortDeps = {
    sessions,
    effortChanges,
    pane,
    client: effortTypeSafe(input.choice ?? "xhigh"),
    accounts: [opusAccount, astraAccount],
    models: [opusModel, astraModel],
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

describe("review pass 3 regressions", () => {
  it("holds a top-tier level the user set in the TUI, which the record does not show", async () => {
    // Codex: the status line says max although the router recorded high.
    const codex = setup({ agent: "codex", record: "high", paneLevel: "max" });
    expect(await executeEffort("sess_live", agentRequest, codex.deps)).toMatchObject({
      code: 4,
      json: { reason: "top-tier-held" },
    });
    expect(codex.pane.keys).toEqual([]);
    // Claude: the calling agent's CLAUDE_EFFORT says max.
    const claude = setup({
      record: "high",
      paneLevel: "max",
      deps: { env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1", CLAUDE_EFFORT: "max" } },
    });
    expect(await executeEffort("sess_live", agentRequest, claude.deps)).toMatchObject({
      code: 4,
      json: { reason: "top-tier-held" },
    });
    expect(claude.pane.keys).toEqual([]);
  });

  it("checks quota for a raise from the level read from the pane", async () => {
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
    // The record says xhigh, but the agent is really at low: high is a raise.
    const { deps, pane } = setup({
      record: "xhigh",
      paneLevel: "low",
      choice: "high",
      deps: {
        accounts: [shared],
        usage: { [shared.id]: usage },
        env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1", CLAUDE_EFFORT: "low" },
      },
    });
    expect(await executeEffort("sess_live", agentRequest, deps)).toMatchObject({
      code: 4,
      json: { reason: "quota" },
    });
    expect(pane.keys).toEqual([]);
  });

  it("re-checks for a newer session once it holds the lock", async () => {
    const { deps, pane, sessions } = setup({ choice: "xhigh" });
    let calls = 0;
    const racing: EffortDeps["sessions"] = {
      get: (id) => sessions.get(id),
      save: (session) => sessions.save(session),
      latestForPane: (paneId) =>
        calls++ === 0
          ? sessions.latestForPane(paneId)
          : launchedSession({ id: "sess_newer", agent: "claude-code", effort: "high" }),
    };
    const result = await executeEffort("sess_live", agentRequest, { ...deps, sessions: racing });
    expect(result).toMatchObject({ code: 4, json: { reason: "superseded-session" } });
    expect(pane.keys).toEqual([]);
  });

  it("keeps its lock through a slow TypeSafe call", async () => {
    const { deps, effortChanges } = setup({ choice: "xhigh" });
    let stolen: boolean | undefined;
    const slow = {
      calls: [] as SystemOneRequest[],
      async systemOne<const Q extends Questions>(request: SystemOneRequest<Q>) {
        // Another caller 150 s into the hold, with a normal lock, still cannot take it.
        stolen = effortChanges.tryLock("wJ:p1", "thief", Date.now() + 150_000, 60_000);
        return effortTypeSafe("xhigh").systemOne(request) as Promise<SystemOneResult<Q>>;
      },
    };
    await executeEffort("sess_live", agentRequest, {
      ...deps,
      client: slow,
      now: () => new Date(),
    });
    expect(stolen).toBe(false);
  });

  it("treats a caller without agent markers as not the target, even from that pane", async () => {
    // CLAUDE_EFFORT=max would hold the level if trusted; unmarked, the record (high) is used.
    const { deps, pane } = setup({
      record: "high",
      paneLevel: "high",
      choice: "xhigh",
      deps: { env: { HERDR_PANE_ID: "wJ:p1", CLAUDE_EFFORT: "max" } },
    });
    const result = await executeEffort("sess_live", agentRequest, deps);
    expect(result).toMatchObject({ code: 0, json: { from: "high", to: "xhigh" } });
    expect(pane.level).toBe("xhigh");
  });

  it("queues the sub-step for an idle Codex agent calling on itself, and not otherwise", async () => {
    const self = setup({ agent: "codex", record: "medium", choice: "high" });
    self.pane.status = "idle";
    const marked = await executeEffort("sess_live", agentRequest, {
      ...self.deps,
      env: { HERDR_PANE_ID: "wJ:p1", CODEX_THREAD_ID: "t" },
    });
    expect(marked).toMatchObject({ code: 0, json: { turnBreak: true } });
    expect(self.pane.keys.at(-1)).toBe("tab");

    const other = setup({ agent: "codex", record: "medium", choice: "high" });
    other.pane.status = "idle";
    const unmarked = await executeEffort("sess_live", agentRequest, {
      ...other.deps,
      env: { HERDR_PANE_ID: "wJ:p1" },
    });
    expect(unmarked).toMatchObject({ code: 0, json: { turnBreak: false } });
    expect(other.pane.texts).toEqual([]);
  });

  it("reports quota before any pane check for a raise the account cannot afford", async () => {
    const shared = AccountSchema.parse({ ...opusAccount, ownership: "shared", reserveFloor: 0.4 });
    const { deps } = setup({ record: "medium", choice: "high", deps: { accounts: [shared] } });
    const busy = new FakePane({ agent: "claude", level: "medium", draft: "typing" });
    expect(await executeEffort("sess_live", agentRequest, { ...deps, pane: busy })).toMatchObject({
      code: 4,
      json: { reason: "quota" },
    });
  });
});
