import { describe, expect, it } from "vitest";
import { AccountSchema } from "../../src/domain/account.js";
import { shouldReconsiderRoute } from "../../src/sessions/phase-transition.js";
import { cacheAffinityKey } from "../../src/sessions/cache-affinity.js";

describe("phase sticky sessions", () => {
  it("keeps a route stable within a phase", () => {
    expect(
      shouldReconsiderRoute({
        currentPhase: "implementation",
        nextPhase: "implementation",
        routeStillEligible: true,
      }),
    ).toBe(false);
  });

  it("reconsiders at a phase boundary after deterministic eligibility", () => {
    expect(
      shouldReconsiderRoute({
        currentPhase: "planning",
        nextPhase: "implementation",
        routeStillEligible: true,
      }),
    ).toBe(true);
    expect(
      shouldReconsiderRoute({
        currentPhase: "planning",
        nextPhase: "implementation",
        routeStillEligible: false,
      }),
    ).toBe(true);
  });

  it("models cache affinity by provider, model, effort, agent, and prompt prefix", () => {
    const account = AccountSchema.parse({
      id: "acct",
      label: "x",
      provider: "cursor",
      agent: "cursor",
      ownership: "personal",
      collectorPreference: ["official-cli"],
      enabledModels: ["cursor:grok-4.6"],
      enabled: true,
    });
    const key = cacheAffinityKey({
      provider: account.provider,
      modelId: "cursor:grok-4.6",
      effort: "medium",
      agent: "cursor",
      promptPrefix: "Implement the approved plan",
    });
    expect(key).toContain("cursor");
    expect(key).toContain("medium");
  });
});
