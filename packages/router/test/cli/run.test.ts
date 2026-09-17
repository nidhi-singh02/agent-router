import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { executeRun } from "../../src/commands/run.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "./fixtures.js";

async function captureHelp(): Promise<string> {
  let out = "";
  const program = createProgram({
    stdout: {
      write(chunk: string) {
        out += chunk;
        return true;
      },
    },
    env: { MODEL_ROUTER_HOME: mkdtempSync(path.join(os.tmpdir(), "router-cli-")) },
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "router", "--help"]);
  } catch {
    // commander throws after help when exitOverride is set
  }
  return out;
}

describe("router run", () => {
  it("prints help for the explicit CLI", async () => {
    const help = await captureHelp();
    expect(help).toMatch(/Usage: router/);
    expect(help).toMatch(/run/);
    expect(help).toMatch(/status/);
  });

  it("selects a safe dry-run route and prints the decision card", async () => {
    const result = await executeRun(
      "Implement the approved session repository plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: { HERDR_ENV: "1" },
        now,
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Selected: cursor \/ grok-4\.6 \/ medium/);
    expect(result.output).toMatch(/Phase: implementation/);
    expect(result.output).toMatch(/Usage source:/);
    expect(result.output).toMatch(/exact/);
    expect(result.output).toMatch(/cursor-grok-4\.6-medium/);
    expect(result.json).toMatchObject({ ok: true, dryRun: true });
  });

  it("reports no eligible route without calling TypeSafe ranking", async () => {
    const client = fakeTypeSafe({});
    const result = await executeRun(
      "Implement the plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.3) },
        client,
        env: {},
        now,
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/No eligible route/);
    expect(result.output).toMatch(/below-reserve/);
    expect(client.calls).toEqual([]);
  });

  it("presents the top two eligible routes when confidence is low and consequence is high", async () => {
    const personalOpaque = `${personal.id}:${cursorModel.id}`;
    const sharedOpaque = `${shared.id}:${claudeModel.id}`;
    const result = await executeRun(
      "Plan a high-stakes architecture change.",
      { dryRun: true },
      {
        accounts: [personal, shared],
        models: [cursorModel, claudeModel],
        usage: {
          [personal.id]: usageFor(personal.id, 0.9),
          [shared.id]: usageFor(shared.id, 0.8),
        },
        client: fakeTypeSafe({
          family: "planning",
          phase: "planning",
          consequence: 3,
          route: personalOpaque,
          routeConfidence: 0.5,
          routeProbabilities: { [personalOpaque]: 0.48, [sharedOpaque]: 0.42 },
        }),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(3);
    expect(result.output).toMatch(/Low confidence/);
    expect(result.output).toContain(personalOpaque);
    expect(result.output).toContain(sharedOpaque);
  });

  it("prevents a duplicate pane split on retry with the same launch token", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const deps = {
      accounts: [personal],
      models: [cursorModel],
      usage: { [personal.id]: usageFor(personal.id, 0.8) },
      client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
      env: { HERDR_ENV: "1" },
      now,
      herdr,
    };
    const first = await executeRun("Implement the approved plan.", { dryRun: false }, deps);
    expect(first.code).toBe(0);
    const second = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      {
        ...deps,
        existingLaunchToken: (first.json as { launchToken?: string }).launchToken,
        existingPaneId: (first.json as { paneId?: string }).paneId,
      },
    );
    expect(second.code).toBe(0);
    expect(calls.filter((argv) => argv[1] === "pane" && argv[2] === "split")).toHaveLength(1);
  });

  it("consumes shared activity before eligibility and excludes conservative shared accounts without TypeSafe ranking", async () => {
    const client = fakeTypeSafe({ family: "implementation" });
    const status = vi.fn(async () => "unreachable" as const);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.85) },
        client,
        env: {},
        now,
        activityClient: { status },
      },
    );
    expect(status).toHaveBeenCalledWith(shared.id);
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/shared-activity-constrained/);
    expect(client.calls).toEqual([]);
  });

  it("keeps a shared account eligible when activity is inactive and still queried first", async () => {
    const client = fakeTypeSafe({ family: "implementation", phase: "implementation" });
    const status = vi.fn(async () => "inactive" as const);
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: usageFor(shared.id, 0.85) },
        client,
        env: {},
        now,
        activityClient: { status },
      },
    );
    expect(status).toHaveBeenCalledWith(shared.id);
    expect(result.code).toBe(0);
    expect(client.calls.length).toBeGreaterThan(0);
  });
});
