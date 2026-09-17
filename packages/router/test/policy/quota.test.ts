import { describe, expect, it } from "vitest";
import { estimateTaskCostRatio } from "../../src/policy/cost-estimator.js";
import { projectedRemainingRatio } from "../../src/policy/quota.js";
import type { UsageSnapshot } from "../../src/domain/usage.js";

function snapshot(
  windows: UsageSnapshot["windows"],
  extra: Partial<UsageSnapshot> = {},
): UsageSnapshot {
  return {
    accountId: "acct_1",
    windows,
    collectedAt: "2026-09-17T09:00:00.000Z",
    source: "official-cli",
    certainty: "exact",
    expiresAt: "2026-09-17T09:05:00.000Z",
    activeReservationRatio: 0,
    ...extra,
  };
}

describe("quota arithmetic", () => {
  it.each([
    { kind: "five-hour" as const, remaining: 0.5 },
    { kind: "daily" as const, remaining: 0.5 },
    { kind: "weekly" as const, remaining: 0.5 },
    { kind: "monthly" as const, remaining: 0.5 },
    { kind: "provider-defined" as const, remaining: 0.5 },
  ])("projects remaining quota for a $kind window", ({ kind, remaining }) => {
    const projected = projectedRemainingRatio(
      snapshot([{ kind, remainingRatio: remaining }], { activeReservationRatio: 0.05 }),
      0.02,
    );
    expect(projected).toBeCloseTo(0.43);
  });

  it("uses the most restrictive window", () => {
    const projected = projectedRemainingRatio(
      snapshot([
        { kind: "five-hour", remainingRatio: 0.9 },
        { kind: "weekly", remainingRatio: 0.41 },
      ]),
      0,
    );
    expect(projected).toBeCloseTo(0.41);
  });

  it("returns undefined when a relevant window has unknown remaining quota", () => {
    expect(
      projectedRemainingRatio(snapshot([{ kind: "five-hour" }], { certainty: "unknown" }), 0),
    ).toBeUndefined();
  });
});

describe("cost estimator", () => {
  it("scales estimated cost by relative quota cost", () => {
    expect(estimateTaskCostRatio({ relativeQuotaCost: 2, baselineRatio: 0.03 })).toBeCloseTo(0.06);
  });
});
