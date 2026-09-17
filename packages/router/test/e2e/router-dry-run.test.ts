import { describe, expect, it } from "vitest";
import { executeRun } from "../../src/commands/run.js";
import { buildHandoff } from "../../src/handoff/handoff-builder.js";
import { shouldReconsiderRoute } from "../../src/sessions/phase-transition.js";
import { cursorModel, fakeTypeSafe, now, personal, usageFor } from "../cli/fixtures.js";

describe("planning to implementation dry run", () => {
  it("routes planning then reconsider implementation with a structured handoff", async () => {
    const planning = await executeRun(
      "Draft the architecture before any code.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.85) },
        client: fakeTypeSafe({ family: "planning", phase: "planning", effort: "high" }),
        env: {},
        now,
      },
    );
    expect(planning.code).toBe(0);
    expect(planning.output).toMatch(/Phase: planning/);

    expect(
      shouldReconsiderRoute({
        currentPhase: "planning",
        nextPhase: "implementation",
        routeStillEligible: true,
      }),
    ).toBe(true);

    const implementation = await executeRun(
      "Implement the already approved plan for the session repository.",
      { dryRun: true },
      {
        accounts: [personal],
        models: [cursorModel],
        usage: { [personal.id]: usageFor(personal.id, 0.85) },
        client: fakeTypeSafe({
          family: "implementation",
          phase: "implementation",
          effort: "medium",
        }),
        env: {},
        now,
      },
    );
    expect(implementation.code).toBe(0);
    expect(implementation.output).toMatch(/Phase: implementation/);
    expect(implementation.output).toMatch(/cursor-grok-4\.6-medium/);

    const handoff = buildHandoff({
      task: "Implement the already approved plan",
      approvedSpec: "SQLite session store with redacted audit events",
      constraints: ["no live deploy"],
      currentPhase: "implementation",
      relevantFiles: ["packages/router/src/store/session-repository.ts"],
      completedChecks: ["domain tests"],
      remainingAcceptanceCriteria: ["dry-run launch"],
    });
    expect(handoff.phase).toBe("implementation");
    expect(handoff.relevantFiles[0]).toMatch(/session-repository/);
  });
});
