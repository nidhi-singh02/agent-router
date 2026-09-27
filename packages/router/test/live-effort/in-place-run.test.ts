import { describe, expect, it } from "vitest";
import { executeRun, type RunDeps } from "../../src/commands/run.js";
import type { ReasoningEffort } from "../../src/domain/model-profile.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { fakeTypeSafe, usageFor } from "../cli/fixtures.js";
import { FakePane, noSleep } from "./fake-pane.js";
import {
  astraAccount,
  astraModel,
  launchedSession,
  opusAccount,
  opusModel,
  store,
} from "./fixtures.js";

function setup(options: {
  agent?: "claude-code" | "codex";
  previousEffort?: ReasoningEffort;
  choice?: string;
  callerPane?: string;
  enabled?: boolean;
  draft?: string;
  rootTask?: string;
}) {
  const agent = options.agent ?? "claude-code";
  const claude = agent === "claude-code";
  const { sessions, effortChanges } = store();
  const previous = launchedSession({
    id: "sess_prev",
    agent,
    effort: options.previousEffort ?? "medium",
    task: options.rootTask ?? "Plan the migration.",
    phase: "planning",
  });
  sessions.save(previous);
  const pane = new FakePane({
    agent: claude ? "claude" : "codex",
    level: options.previousEffort ?? "medium",
    status: options.callerPane === "wJ:p1" ? "working" : "idle",
    ...(options.draft ? { draft: options.draft } : {}),
  });
  const herdrCalls: string[][] = [];
  const herdr = createHerdrClient(async (argv) => {
    herdrCalls.push([...argv]);
    return { ok: true, code: 0, stdout: "wJ:p7\n", stderr: "" };
  });
  const account = claude ? opusAccount : astraAccount;
  const model = claude ? opusModel : astraModel;
  const client = fakeTypeSafe({
    phase: "implementation",
    family: "implementation",
    route: `${account.id}:${model.id}`,
    effort: options.choice ?? "high",
  });
  const deps: RunDeps = {
    accounts: [account],
    models: [model],
    usage: { [account.id]: usageFor(account.id, 0.8) },
    client,
    // As in production: the launch env keeps HERDR_* only, and the agent markers arrive
    // through the caller's allowlisted variables.
    env: {
      HERDR_ENV: "1",
      ...(options.callerPane ? { HERDR_PANE_ID: options.callerPane } : {}),
    },
    callerEnv: {
      ...(options.callerPane ? { HERDR_PANE_ID: options.callerPane } : {}),
      // From inside the recorded pane, the caller is that pane's agent.
      ...(options.callerPane === "wJ:p1"
        ? { CLAUDECODE: "1", CLAUDE_EFFORT: options.previousEffort ?? "medium" }
        : {}),
    },
    now: new Date("2026-09-17T09:01:00.000Z"),
    herdr,
    herdrPane: pane,
    sessions,
    effortChanges,
    liveEffortEnabled: options.enabled ?? true,
    sleep: noSleep,
    switchTimeoutMs: 100,
  };
  return { deps, pane, herdrCalls, sessions, effortChanges, client };
}

const NEXT = "Implement the approved plan in docs/plans/x.md";
const split = (calls: string[][]) =>
  calls.some((argv) => argv[1] === "pane" && argv[2] === "split");

describe("router run --session with live effort", () => {
  it("continues in the calling pane and switches Claude's effort mid-turn", async () => {
    const { deps, pane, herdrCalls, sessions, effortChanges } = setup({ callerPane: "wJ:p1" });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(false);
    expect(pane.level).toBe("high");
    expect(result.output).toContain("Continuation: in place (pane wJ:p1), effort medium -> high");
    expect(result.output).toContain(
      "Continue in this session: phase implementation, effort now high.",
    );
    const json = result.json as { sessionId: string; paneId: string; continuation: unknown };
    expect(json.paneId).toBe("wJ:p1");
    expect(json.continuation).toMatchObject({ mode: "in-place", from: "medium", to: "high" });
    const session = sessions.get(json.sessionId);
    expect(session).toMatchObject({
      previousSessionId: "sess_prev",
      paneId: "wJ:p1",
      continuation: "in-place",
      liveEffort: "high",
      route: { agentName: "router-claude-abc123", effort: "high" },
    });
    expect(effortChanges.listForSession(json.sessionId)).toMatchObject([
      { source: "phase-boundary", from: "medium", to: "high", status: "applied" },
    ]);
  });

  it("queues the next phase in a Codex pane that asked from inside itself", async () => {
    const { deps, pane } = setup({ agent: "codex", callerPane: "wJ:p1" });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(pane.level).toBe("high");
    expect(pane.queued).toHaveLength(1);
    expect(pane.queued[0]).toContain(NEXT);
    expect(pane.queued[0]).not.toContain("\n");
    expect(result.output).toContain("End your turn now");
  });

  it("switches an idle pane, then prompts it, when called from elsewhere", async () => {
    const { deps, pane, herdrCalls } = setup({ callerPane: "wJ:p5" });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(pane.level).toBe("high");
    expect(split(herdrCalls)).toBe(false);
    const prompt = herdrCalls.find((argv) => argv[1] === "agent" && argv[2] === "prompt");
    expect(prompt?.[3]).toBe("router-claude-abc123");
    expect(prompt?.[4]).toContain(NEXT);
  });

  it("hands over without keystrokes when the effort does not change", async () => {
    const { deps, pane } = setup({ callerPane: "wJ:p1", choice: "medium" });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.output).toContain("effort medium unchanged");
    expect(pane.keys).toEqual([]);
  });

  it("falls back to a new pane when the recorded agent is gone, even without a switch", async () => {
    const { deps, herdrCalls, pane } = setup({ callerPane: "wJ:p1", choice: "medium" });
    const gone = { ...pane, getAgent: async () => undefined } as unknown as typeof pane;
    const result = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev" },
      { ...deps, herdrPane: gone },
    );
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(true);
    expect(result.output).toContain("in-place continuation failed: pane-drift");
  });

  it("marks the chain unsupported when Claude shows the cache warning at a phase boundary", async () => {
    const { deps, herdrCalls, sessions } = setup({ callerPane: "wJ:p5" });
    const pane = new FakePane({ agent: "claude", level: "medium", cacheDialog: true });
    const result = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev" },
      { ...deps, herdrPane: pane },
    );
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(true);
    expect(result.output).toContain("in-place continuation failed: cache-warning");
    const json = result.json as { sessionId: string };
    expect(sessions.get(json.sessionId)?.liveSwitchUnsupported).toBe(true);
  });

  it("keeps a top-tier pane in place at its own level", async () => {
    const { deps, herdrCalls, pane } = setup({
      callerPane: "wJ:p1",
      previousEffort: "max",
      choice: "max",
      rootTask: "Plan the migration, ultra careful.",
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(false);
    expect(result.output).toContain("effort max unchanged");
    expect(pane.keys).toEqual([]);
  });

  it("never hands a phase to another agent's pane", async () => {
    const { deps, herdrCalls, pane } = setup({});
    const result = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev" },
      {
        ...deps,
        env: { ...deps.env, HERDR_PANE_ID: "wJ:p5" },
        callerEnv: { HERDR_PANE_ID: "wJ:p5", CLAUDECODE: "1" },
      },
    );
    expect(result.output).toContain("new pane (not-caller-pane)");
    expect(split(herdrCalls)).toBe(true);
    expect(pane.keys).toEqual([]);
    expect(
      herdrCalls.some((argv) => argv[2] === "prompt" && argv[3] === "router-claude-abc123"),
    ).toBe(false);
  });

  it("opens a new pane when Herdr refuses the prompt outright", async () => {
    const { deps, herdrCalls } = setup({ callerPane: "wJ:p5", choice: "medium" });
    let refused = false;
    const herdr = createHerdrClient(async (argv) => {
      herdrCalls.push([...argv]);
      if (argv[2] === "prompt" && argv[3] === "router-claude-abc123" && !refused) {
        refused = true;
        return { ok: false, code: 1, stdout: '{"error":{"code":"agent_blocked"}}', stderr: "" };
      }
      return { ok: true, code: 0, stdout: "wJ:p7\n", stderr: "" };
    });
    const result = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev" },
      { ...deps, herdr },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("in-place continuation failed: prompt-refused");
    expect(split(herdrCalls)).toBe(true);
  });

  it("does not continue a superseded session in its old pane", async () => {
    const { deps, herdrCalls, pane, sessions } = setup({ callerPane: "wJ:p5" });
    sessions.save(
      launchedSession({
        id: "sess_newer",
        agent: "claude-code",
        effort: "high",
        phase: "implementation",
        extras: { createdAt: "2026-09-26T09:30:00.000Z", continuation: "in-place" },
      }),
    );
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.output).toContain("new pane (superseded-session)");
    expect(split(herdrCalls)).toBe(true);
    expect(pane.keys).toEqual([]);
  });

  it("previews the continuation on a dry run without touching the pane", async () => {
    const { deps, pane, herdrCalls } = setup({ callerPane: "wJ:p1" });
    const result = await executeRun(NEXT, { dryRun: true, previousSessionId: "sess_prev" }, deps);
    expect(result.output).toContain(
      "Continuation: would continue in place (pane wJ:p1), effort medium -> high",
    );
    expect(pane.keys).toEqual([]);
    expect(herdrCalls).toEqual([]);
  });

  it("opens a new pane when the feature is disabled", async () => {
    const { deps, herdrCalls, pane } = setup({ callerPane: "wJ:p1", enabled: false });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(true);
    expect(pane.keys).toEqual([]);
    expect(result.output).not.toContain("Continuation:");
  });

  it("falls back to a new pane when the switch cannot run", async () => {
    const { deps, herdrCalls, sessions } = setup({ callerPane: "wJ:p5", draft: "typing" });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(true);
    expect(result.output).toContain("new pane (in-place continuation failed: pane-input-busy)");
    const json = result.json as { sessionId: string };
    expect(sessions.get(json.sessionId)?.continuation).toBeUndefined();
  });

  it("opens a new pane for a top-tier level", async () => {
    const { deps, herdrCalls, pane } = setup({
      callerPane: "wJ:p1",
      choice: "max",
      rootTask: "Plan the migration with ultra care.",
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(split(herdrCalls)).toBe(true);
    expect(pane.keys).toEqual([]);
    expect(result.output).toContain("new pane (top-tier-requires-new-pane)");
  });
});

describe("top-tier gate", () => {
  const efforts = (client: ReturnType<typeof setup>["client"]) => {
    const call = client.calls.find((item) => "effort" in item.questions);
    return Object.keys((call!.questions.effort as { criteria: Record<string, string> }).criteria);
  };

  it("never lets a continued task unlock the top tier", async () => {
    const { deps, client } = setup({ enabled: false });
    await executeRun(
      "Implement it with ultra effort",
      { dryRun: true, previousSessionId: "sess_prev" },
      deps,
    );
    expect(efforts(client)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("inherits the unlock from the root task", async () => {
    const { deps, client, sessions } = setup({
      enabled: false,
      rootTask: "Plan it, ultra careful.",
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(efforts(client)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const json = result.json as { sessionId: string };
    expect(sessions.get(json.sessionId)?.topTierUnlocked).toBe(true);
  });

  it("unlocks from a root run's own task", async () => {
    const { deps, client } = setup({ enabled: false });
    await executeRun("Do this with ultra reasoning", { dryRun: true }, deps);
    expect(efforts(client)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
