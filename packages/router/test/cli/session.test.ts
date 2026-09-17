import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
