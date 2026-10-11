import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun } from "../../src/commands/run.js";
import { createHerdrClient, type CommandResult } from "../../src/launch/herdr-client.js";
import { ReservationRepository } from "../../src/store/reservation-repository.js";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import { openDatabase } from "../../src/store/database.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { cursorModel, fakeTypeSafe, now, personal, usageFor } from "./fixtures.js";

/** Follow-ups through `router run` into an existing pane, with a fake Herdr and herdr-send. */
function setup(send: Omit<CommandResult, "ok">, options: { waitOk?: boolean } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-follow-up-"));
  const db = openDatabase({ home });
  const sessions = new SessionRepository(db);
  const reservations = new ReservationService(Date.now, new ReservationRepository(db));
  const calls: string[][] = [];
  const herdr = createHerdrClient(async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "herdr-send") {
      return { ok: send.code === 0, ...send };
    }
    if (argv[2] === "wait") {
      const ok = options.waitOk ?? true;
      return { ok, code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "timeout" };
    }
    // `herdr agent get` reports nothing, so the pane's agent name stays unknown.
    return { ok: false, code: 1, stdout: "", stderr: "" };
  });
  const deps = {
    accounts: [personal],
    models: [cursorModel],
    usage: { [personal.id]: usageFor(personal.id, 0.8) },
    client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
    env: { HERDR_ENV: "1" },
    now,
    herdr,
    sessions,
    reservations,
    existingPaneId: "w1:p3",
  };
  return { db, sessions, reservations, calls, deps };
}

const json = (value: object) => `${JSON.stringify(value)}\n`;
const run = (deps: Parameters<typeof executeRun>[2]) =>
  executeRun("Implement the approved plan.", { dryRun: false }, deps);

describe("router run follow-up into an existing pane", () => {
  it("pane-only: records no invented token or name, and a rerun with its result targets the pane", async () => {
    const ctx = setup({ code: 0, stdout: json({ result: "ok" }), stderr: "" });
    const first = await run(ctx.deps);
    expect(first.code).toBe(0);
    const out = first.json as { launchToken?: string; paneId?: string; agentName?: string };
    expect(out).toMatchObject({ paneId: "w1:p3" });
    expect(out.launchToken).toBeUndefined();
    expect(out.agentName).toBeUndefined();
    const session = ctx.sessions.latest()!;
    expect(session.paneId).toBe("w1:p3");
    expect(session.route?.launchToken).toBeUndefined();
    expect(session.route?.agentName).toBeUndefined();

    const second = await run({
      ...ctx.deps,
      existingLaunchToken: out.launchToken,
      existingPaneId: out.paneId,
    });
    expect(second.code).toBe(0);
    const targets = ctx.calls.filter((argv) => argv[0] === "herdr-send").map((argv) => argv[7]);
    expect(targets).toEqual(["w1:p3", "w1:p3"]);
    expect(ctx.calls.flat().some((arg) => /^router-cursor-/.test(arg))).toBe(false);
    expect(ctx.calls.some((argv) => argv[2] === "split" || argv[2] === "start")).toBe(false);
    ctx.db.close();
  });

  it("exit 4 unconfirmed: the session is saved as launched and the reservation is held", async () => {
    const ctx = setup(
      {
        code: 4,
        stdout: json({ result: "sent_unconfirmed", reason: "agent_prompt_stalled", state: "idle" }),
        stderr: "",
      },
      { waitOk: false },
    );
    const result = await run(ctx.deps);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Do not resend it/);
    const session = ctx.sessions.latest()!;
    expect(session.route).toMatchObject({ status: "launched" });
    expect(session.paneId).toBe("w1:p3");
    expect(session.reservations).toHaveLength(1);
    expect(ctx.reservations.activeRatio(personal.id)).toBeGreaterThan(0);
    expect(ctx.calls.filter((argv) => argv[0] === "herdr-send")).toHaveLength(1);
    ctx.db.close();
  });

  it("exit 3 with unreadable output: delivery unknown is held like exit 4, not released", async () => {
    const ctx = setup({ code: 3, stdout: "garbage\n", stderr: "" });
    const result = await run(ctx.deps);
    expect(result.code).toBe(1);
    expect(ctx.sessions.latest()!.route).toMatchObject({ status: "launched" });
    expect(ctx.reservations.activeRatio(personal.id)).toBeGreaterThan(0);
    ctx.db.close();
  });

  it("exit 3 while busy: nothing was sent, so the reservation is released", async () => {
    const ctx = setup({ code: 3, stdout: json({ result: "timeout", state: "busy" }), stderr: "" });
    const result = await run(ctx.deps);
    expect(result.code).toBe(1);
    expect(ctx.sessions.latest()!.route).toMatchObject({ status: "launch-failed" });
    expect(ctx.reservations.activeRatio(personal.id)).toBe(0);
    ctx.db.close();
  });
});
