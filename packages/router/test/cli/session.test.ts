import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { executeRun } from "../../src/commands/run.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { openDatabase } from "../../src/store/database.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { cursorModel, fakeTypeSafe, now, personal, usageFor } from "./fixtures.js";

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "router-session-"));
}

function runDeps(home: string, env: NodeJS.Dict<string>) {
  const db = openDatabase({ home });
  return {
    db,
    deps: {
      home,
      accounts: [personal],
      models: [cursorModel],
      usage: { [personal.id]: usageFor(personal.id, 0.8) },
      client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
      env,
      now,
      herdr: createHerdrClient(async () => ({
        ok: true,
        code: 0,
        stdout: "pane_abc\n",
        stderr: "",
      })),
      sessions: new SessionRepository(db),
    },
  };
}

async function cli(home: string, args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(["node", "router", ...args], {
    stdout: {
      write(chunk: string) {
        out += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        err += chunk;
        return true;
      },
    },
    env: { MODEL_ROUTER_HOME: home },
  });
  return { out, err, code };
}

describe("router sessions", () => {
  it("records a launched route as a session", async () => {
    const home = tempHome();
    const { db, deps } = runDeps(home, { HERDR_ENV: "1" });
    const result = await executeRun("Implement the approved plan.", { dryRun: false }, deps);
    expect(result.code).toBe(0);
    const sessionId = (result.json as { sessionId?: string }).sessionId;
    expect(sessionId).toMatch(/^sess_/);
    const session = deps.sessions.get(sessionId!);
    expect(session).toMatchObject({
      task: "Implement the approved plan.",
      phase: "implementation",
      paneId: "pane_abc",
      route: {
        accountId: personal.id,
        modelId: cursorModel.id,
        agent: "cursor",
        launchName: "grok-4.6",
        effort: "medium",
        status: "launched",
        agentName: expect.stringMatching(/^router-cursor-[0-9a-f]{6}$/),
      },
    });
    expect(session?.handoffs).toHaveLength(1);
    expect(session?.reservations).toHaveLength(1);
    db.close();
  });

  it("records a failed launch with its error", async () => {
    const home = tempHome();
    const { db, deps } = runDeps(home, {});
    const result = await executeRun("Implement the approved plan.", { dryRun: false }, deps);
    expect(result.code).toBe(1);
    const session = deps.sessions.latest();
    expect(session?.route).toMatchObject({
      status: "launch-failed",
      error: "HERDR_ENV=1 is required to launch a pane",
    });
    db.close();
  });

  it("does not record dry runs", async () => {
    const home = tempHome();
    const { db, deps } = runDeps(home, { HERDR_ENV: "1" });
    const result = await executeRun("Implement the approved plan.", { dryRun: true }, deps);
    expect(result.code).toBe(0);
    expect(deps.sessions.latest()).toBeUndefined();
    db.close();
  });

  it("shows the latest session, a session by id, and the session list", async () => {
    const home = tempHome();
    const { db, deps } = runDeps(home, { HERDR_ENV: "1" });
    const first = await executeRun("Plan the migration.", { dryRun: false }, deps);
    const firstId = (first.json as { sessionId: string }).sessionId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await executeRun("Implement the approved plan.", { dryRun: false }, deps);
    const secondId = (second.json as { sessionId: string }).sessionId;
    db.close();

    const latest = await cli(home, ["session"]);
    expect(latest.code).toBe(0);
    expect(latest.out).toContain(`Session: ${secondId}`);
    expect(latest.out).toContain("Task: Implement the approved plan.");
    expect(latest.out).toContain(`Route: cursor / grok-4.6 / medium (${personal.id})`);
    expect(latest.out).toContain("Status: launched");
    expect(latest.out).toContain("Pane: pane_abc");
    expect(latest.out).toMatch(/Agent: router-cursor-[0-9a-f]{6}/);

    const byId = await cli(home, ["session", firstId]);
    expect(byId.code).toBe(0);
    expect(byId.out).toContain("Task: Plan the migration.");

    const listed = await cli(home, ["session", "--list"]);
    expect(listed.code).toBe(0);
    const lines = listed.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(secondId);
    expect(lines[1]).toContain(firstId);

    const json = await cli(home, ["session", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ id: secondId, route: { status: "launched" } });
  });

  it("reports an empty store and an unknown session id", async () => {
    const home = tempHome();
    const empty = await cli(home, ["session"]);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain("No router sessions yet.");

    const missing = await cli(home, ["session", "sess_missing"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Session not found: sess_missing");
  });
});

describe("phase handoffs between router sessions", () => {
  function capturePrompts(deps: ReturnType<typeof runDeps>["deps"]) {
    const prompts: string[] = [];
    deps.herdr = createHerdrClient(async (argv) => {
      if (argv[2] === "prompt") prompts.push(argv[4] ?? "");
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    return prompts;
  }

  it("tells a launched agent its session id and how to route the next phase", async () => {
    const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
    const prompts = capturePrompts(deps);
    const result = await executeRun("Plan the billing feature.", { dryRun: false }, deps);
    const sessionId = (result.json as { sessionId: string }).sessionId;
    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("- Do not deploy or publish anything without asking the user.");
    expect(prompt).not.toMatch(/consume extra quota/);
    expect(prompt).toContain(`Router session: ${sessionId}`);
    expect(prompt).toContain(`router session ${sessionId}`);
    expect(prompt).toContain(`router run --session ${sessionId} "<next-phase task`);
    expect(prompt).toMatch(/ask the user/i);
    expect(prompt).toMatch(/model-router skill/);
    expect(deps.sessions.get(sessionId)?.handoffs[0]?.task).toBe("Plan the billing feature.");
    db.close();
  });

  it("does not add router session instructions to a dry run", async () => {
    const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
    const result = await executeRun("Plan the billing feature.", { dryRun: true }, deps);
    expect(result.output).not.toContain("Router session:");
    db.close();
  });

  it("links the next phase to the previous session and passes its context", async () => {
    const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
    const planning = await executeRun("Plan the billing feature.", { dryRun: false }, deps);
    const planningId = (planning.json as { sessionId: string }).sessionId;
    const planningSession = deps.sessions.get(planningId)!;
    deps.sessions.save({ ...planningSession, phase: "planning" });

    const prompts = capturePrompts(deps);
    const result = await executeRun(
      "Implement the plan in docs/plans/billing.md.",
      { dryRun: false, previousSessionId: planningId },
      deps,
    );
    expect(result.code).toBe(0);
    const nextId = (result.json as { sessionId: string }).sessionId;
    expect(nextId).not.toBe(planningId);
    expect(deps.sessions.get(nextId)?.previousSessionId).toBe(planningId);
    expect(prompts[0]).toContain(
      `Previous phase: planning (session ${planningId}): Plan the billing feature.`,
    );
    expect(result.output).toContain(`Previous session: ${planningId} (planning -> implementation)`);
    expect(result.output).toMatch(/Cache decision: phase change justifies a structured handoff/);

    const shown = await cli(deps.home, ["session", nextId]);
    expect(shown.out).toContain(`Previous session: ${planningId}`);
    db.close();
  });

  it("reuses the previous route when the next task stays in the same phase", async () => {
    const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
    const first = await executeRun("Implement the billing repository.", { dryRun: false }, deps);
    const firstId = (first.json as { sessionId: string }).sessionId;
    deps.sessions.save({ ...deps.sessions.get(firstId)!, phase: "implementation" });
    const second = await executeRun(
      "Continue implementing the billing repository.",
      { dryRun: false, previousSessionId: firstId },
      deps,
    );
    expect(second.code).toBe(0);
    expect(second.output).toMatch(/Cache decision: reused previous route \(same phase\)/);
    expect(second.json).toMatchObject({
      selected: `${personal.id}:${cursorModel.id}`,
      effort: "medium",
    });
    const rankingCalls = (deps.client.calls as { questions: object }[]).filter(
      (call) => "route" in call.questions,
    );
    expect(rankingCalls).toHaveLength(1);
    db.close();
  });

  it("stops before routing when the previous session does not exist", async () => {
    const { db, deps } = runDeps(tempHome(), { HERDR_ENV: "1" });
    const result = await executeRun(
      "Implement the plan.",
      { dryRun: true, previousSessionId: "sess_missing" },
      deps,
    );
    expect(result.code).toBe(2);
    expect(result.output).toBe("Session not found: sess_missing");
    expect(deps.client.calls).toEqual([]);
    db.close();
  });

  it("passes --session from the CLI to the run", async () => {
    const run = vi.fn(async () => ({ output: "ok", json: {}, code: 0 }));
    const silent = { write: () => true };
    await runCli(["node", "router", "run", "Implement it", "--session", "sess_prev", "--dry-run"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: tempHome() },
      run,
      runDeps: {
        accounts: [],
        models: [],
        usage: {},
        client: fakeTypeSafe({}),
        env: {},
      },
    });
    expect(run).toHaveBeenCalledWith(
      "Implement it",
      { dryRun: true, previousSessionId: "sess_prev", noEnrich: false },
      expect.anything(),
    );
  });
});
