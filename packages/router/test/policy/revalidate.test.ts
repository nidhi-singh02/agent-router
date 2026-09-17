import { describe, expect, it } from "vitest";
import { AccountSchema } from "../../src/domain/account.js";
import { ModelProfileSchema } from "../../src/domain/model-profile.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
import { revalidateDecision } from "../../src/policy/revalidate.js";

const now = new Date("2026-09-17T09:01:00.000Z");
const account = AccountSchema.parse({
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
  id: "anthropic:claude-sonnet",
  provider: "anthropic",
  agent: "claude-code",
  launchName: "sonnet",
  supportedEfforts: ["medium"],
  capabilities: { planning: 0.5, coding: 0.5, debugging: 0.5, creativity: 0.5, research: 0.5 },
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

describe("launch revalidation", () => {
  it("accepts a still-safe choice", () => {
    const result = revalidateDecision({
      account,
      model,
      usage: UsageSnapshotSchema.parse({
        accountId: account.id,
        windows: [{ kind: "five-hour", remainingRatio: 0.8 }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "exact",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      estimatedCostRatio: 0.02,
      selectedEffort: "medium",
      now,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a choice that is no longer safe", () => {
    const result = revalidateDecision({
      account,
      model,
      usage: UsageSnapshotSchema.parse({
        accountId: account.id,
        windows: [{ kind: "five-hour", remainingRatio: 0.41 }],
        collectedAt: "2026-09-17T09:00:50.000Z",
        source: "official-cli",
        certainty: "exact",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      estimatedCostRatio: 0.02,
      selectedEffort: "medium",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("below-reserve");
    }
  });

  it("rejects an unsupported effort even if quota is fine", () => {
    const result = revalidateDecision({
      account,
      model,
      usage: UsageSnapshotSchema.parse({
        accountId: account.id,
        windows: [{ kind: "five-hour", remainingRatio: 0.9 }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "exact",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      estimatedCostRatio: 0,
      selectedEffort: "ultra",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported-effort");
    }
  });
});
