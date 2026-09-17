import { describe, expect, it } from "vitest";
import { AccountSchema } from "../../src/domain/account.js";
import { ModelProfileSchema } from "../../src/domain/model-profile.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
import { evaluateEligibility } from "../../src/policy/eligibility.js";
import { isFresh } from "../../src/policy/freshness.js";

const now = new Date("2026-09-17T09:01:00.000Z");

const personal = AccountSchema.parse({
  id: "acct_personal",
  label: "personal",
  provider: "cursor",
  agent: "cursor",
  ownership: "personal",
  collectorPreference: ["official-cli"],
  enabledModels: ["cursor:grok-4.6"],
  enabled: true,
});

const shared = AccountSchema.parse({
  id: "acct_shared",
  label: "shared",
  provider: "anthropic",
  agent: "claude-code",
  ownership: "shared",
  collectorPreference: ["official-cli"],
  enabledModels: ["anthropic:claude-sonnet"],
  enabled: true,
});

const model = ModelProfileSchema.parse({
  id: "cursor:grok-4.6",
  provider: "cursor",
  agent: "cursor",
  launchName: "grok-4.6",
  supportedEfforts: ["medium"],
  capabilities: { planning: 0.5, coding: 0.5, debugging: 0.5, creativity: 0.5, research: 0.5 },
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

const sharedModel = ModelProfileSchema.parse({
  ...model,
  id: "anthropic:claude-sonnet",
  provider: "anthropic",
  agent: "claude-code",
  launchName: "sonnet",
});

function usage(remainingRatio: number | undefined, extras: Record<string, unknown> = {}) {
  return UsageSnapshotSchema.parse({
    accountId: shared.id,
    windows: [{ kind: "five-hour", ...(remainingRatio === undefined ? {} : { remainingRatio }) }],
    collectedAt: "2026-09-17T09:00:00.000Z",
    source: "official-cli",
    certainty: remainingRatio === undefined ? "unknown" : "exact",
    expiresAt: "2026-09-17T09:05:00.000Z",
    activeReservationRatio: 0,
    ...extras,
  });
}

describe("freshness", () => {
  it("treats expired snapshots as stale", () => {
    expect(isFresh(usage(0.9, { expiresAt: "2026-09-17T08:59:00.000Z" }), now)).toBe(false);
    expect(isFresh(usage(0.9), now)).toBe(true);
  });
});

describe("eligibility", () => {
  it("allows shared accounts at 41% and exactly 40% remaining after cost and reservations", () => {
    const at41 = evaluateEligibility({
      account: shared,
      model: sharedModel,
      usage: usage(0.5, { accountId: shared.id, activeReservationRatio: 0.07 }),
      estimatedCostRatio: 0.02,
      now,
    });
    const at40 = evaluateEligibility({
      account: shared,
      model: sharedModel,
      usage: usage(0.42, { accountId: shared.id, activeReservationRatio: 0.02 }),
      estimatedCostRatio: 0,
      now,
    });
    expect(at41.eligible).toBe(true);
    expect(at41.projectedRemainingRatio).toBeCloseTo(0.41);
    expect(at40.eligible).toBe(true);
    expect(at40.projectedRemainingRatio).toBeCloseTo(0.4);
  });

  it("excludes shared accounts that would fall below 40%", () => {
    const result = evaluateEligibility({
      account: shared,
      model: sharedModel,
      usage: usage(0.45, { accountId: shared.id, activeReservationRatio: 0.04 }),
      estimatedCostRatio: 0.02,
      now,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("below-reserve");
    expect(result.projectedRemainingRatio).toBeCloseTo(0.39);
  });

  it("allows personal accounts to consume below the 40% shared reserve", () => {
    const result = evaluateEligibility({
      account: personal,
      model,
      usage: usage(0.2, { accountId: personal.id }),
      estimatedCostRatio: 0.05,
      now,
    });
    expect(result.eligible).toBe(true);
    expect(result.projectedRemainingRatio).toBeCloseTo(0.15);
  });

  it("does not exclude a personal account when its model pool is exhausted", () => {
    const pooledUsage = usage(undefined, {
      accountId: personal.id,
      certainty: "estimated",
      windows: [
        { kind: "monthly", pool: "spend", remainingRatio: 0 },
        { kind: "monthly", pool: "auto", remainingRatio: 0.8 },
      ],
    });
    const spendModel = ModelProfileSchema.parse({ ...model, quotaPool: "spend" });
    const autoModel = ModelProfileSchema.parse({
      ...model,
      id: "cursor:composer-2.5",
      launchName: "composer-2.5",
      quotaPool: "auto",
    });
    const account = AccountSchema.parse({
      ...personal,
      enabledModels: ["cursor:grok-4.6", "cursor:composer-2.5"],
    });
    const spend = evaluateEligibility({
      account,
      model: spendModel,
      usage: pooledUsage,
      estimatedCostRatio: 0.02,
      now,
    });
    expect(spend.eligible).toBe(true);
    expect(spend.projectedRemainingRatio).toBeCloseTo(-0.02);
    const auto = evaluateEligibility({
      account,
      model: autoModel,
      usage: pooledUsage,
      estimatedCostRatio: 0.02,
      now,
    });
    expect(auto.eligible).toBe(true);
    expect(auto.projectedRemainingRatio).toBeCloseTo(0.78);
  });

  it("lets a personal account through when usage is unknown, and still excludes shared unknown or stale usage", () => {
    const personalUnknown = evaluateEligibility({
      account: personal,
      model,
      usage: usage(undefined, { accountId: personal.id, certainty: "unknown" }),
      estimatedCostRatio: 0,
      now,
    });
    const sharedUnknown = evaluateEligibility({
      account: shared,
      model: sharedModel,
      usage: usage(undefined, { accountId: shared.id, certainty: "unknown" }),
      estimatedCostRatio: 0,
      now,
    });
    const stale = evaluateEligibility({
      account: shared,
      model: sharedModel,
      usage: usage(0.9, { accountId: shared.id, expiresAt: "2026-09-17T08:00:00.000Z" }),
      estimatedCostRatio: 0,
      now,
    });
    expect(personalUnknown).toMatchObject({ eligible: true, projectedRemainingRatio: 1 });
    expect(sharedUnknown).toMatchObject({ eligible: false, reason: "unknown-usage" });
    expect(stale).toMatchObject({ eligible: false, reason: "stale-usage" });
  });

  it("returns structured reasons rather than booleans alone", () => {
    const disabled = evaluateEligibility({
      account: { ...personal, enabled: false },
      model,
      usage: usage(0.9, { accountId: personal.id }),
      estimatedCostRatio: 0,
      now,
    });
    expect(disabled).toEqual({ eligible: false, reason: "account-disabled" });
  });
});
