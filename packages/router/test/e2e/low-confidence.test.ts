import { describe, expect, it } from "vitest";
import { executeRun } from "../../src/commands/run.js";
import { collectUsageChain } from "../../src/collectors/collector-chain.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "../cli/fixtures.js";

describe("failure and confidence paths", () => {
  it("asks the user when a consequential route is low confidence", async () => {
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
          routeConfidence: 0.4,
          routeProbabilities: { [personalOpaque]: 0.46, [sharedOpaque]: 0.44 },
        }),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(3);
    expect(result.output).toMatch(/Low confidence/);
  });

  it("keeps unknown collector failure as unknown usage", async () => {
    const snapshot = await collectUsageChain(personal, [
      {
        kind: "official-cli",
        detectAccounts: async () => [],
        listAvailableModels: async () => [],
        collectUsage: async () => {
          throw new Error("cli failed");
        },
      },
    ]);
    expect(snapshot.certainty).toBe("unknown");
    const result = await executeRun(
      "Implement the plan.",
      { dryRun: true },
      {
        accounts: [shared],
        models: [claudeModel],
        usage: { [shared.id]: snapshot },
        client: fakeTypeSafe({}),
        env: {},
        now,
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/unknown-usage|No eligible route/);
  });

  it("does not invent a semantic judgment when TypeSafe is down", async () => {
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: {
          calls: [],
          systemOne: async () => {
            throw new Error("typesafe unavailable");
          },
        },
        env: {},
        now,
      },
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/TypeSafe could not select/);
  });

  it("reports launch failure without creating a duplicate retry split", async () => {
    const herdr = createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "pane start blocked",
    }));
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.8) },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: { HERDR_ENV: "1" },
        now,
        herdr,
      },
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/blocked|failed|start/i);
  });
});
