import { describe, expect, it } from "vitest";
import {
  AccountSchema,
  ModelProfileSchema,
  RouteCandidateSchema,
  RouteDecisionSchema,
  RouterSessionSchema,
  UsageSnapshotSchema,
} from "../../src/domain/schemas.js";

describe("AccountSchema", () => {
  it("accepts a personal account with an arbitrary user-defined label", () => {
    const account = AccountSchema.parse({
      id: "acct_personal_cursor",
      label: "Nidhi weekend box",
      provider: "cursor",
      agent: "cursor",
      ownership: "personal",
      collectorPreference: ["official-cli", "local-session", "browser-dashboard"],
      enabledModels: ["cursor:grok-4.6"],
      enabled: true,
    });

    expect(account.ownership).toBe("personal");
    expect(account.label).toBe("Nidhi weekend box");
    expect(account.reserveFloor).toBe(0);
  });

  it("defaults shared reserve floor to 0.40", () => {
    const account = AccountSchema.parse({
      id: "acct_shared_anthropic",
      label: "family claude",
      provider: "anthropic",
      agent: "claude-code",
      ownership: "shared",
      collectorPreference: ["official-cli"],
      enabledModels: ["anthropic:claude-opus"],
      enabled: true,
    });

    expect(account.reserveFloor).toBe(0.4);
  });

  it("models OpenCode as a harness whose account points at an underlying provider", () => {
    const account = AccountSchema.parse({
      id: "acct_opencode_openai",
      label: "opencode via openai",
      provider: "openai",
      agent: "opencode",
      ownership: "personal",
      collectorPreference: ["official-cli"],
      enabledModels: ["openai:gpt-5"],
      enabled: true,
    });

    expect(account.agent).toBe("opencode");
    expect(account.provider).toBe("openai");
  });

  it("rejects malformed ownership and reserve floors", () => {
    const base = {
      id: "acct_bad",
      label: "bad",
      provider: "cursor",
      agent: "cursor",
      collectorPreference: ["official-cli"],
      enabledModels: ["cursor:grok-4.6"],
      enabled: true,
    };

    expect(() => AccountSchema.parse({ ...base, ownership: "borrowed" })).toThrow();
    expect(() =>
      AccountSchema.parse({ ...base, ownership: "shared", reserveFloor: 1.4 }),
    ).toThrow();
    expect(() =>
      AccountSchema.parse({ ...base, ownership: "shared", reserveFloor: -0.1 }),
    ).toThrow();
  });
});

describe("UsageSnapshotSchema", () => {
  it("keeps unknown usage distinct from zero remaining quota", () => {
    const unknown = UsageSnapshotSchema.parse({
      accountId: "acct_shared_anthropic",
      windows: [{ kind: "five-hour" }],
      collectedAt: "2026-09-17T09:00:00.000Z",
      source: "official-cli",
      certainty: "unknown",
      expiresAt: "2026-09-17T09:05:00.000Z",
      activeReservationRatio: 0,
    });

    expect(unknown.certainty).toBe("unknown");
    expect(unknown.windows[0]?.remainingRatio).toBeUndefined();
    expect(unknown.windows[0]?.usedRatio).toBeUndefined();
  });

  it("accepts exact usage across supported reset windows", () => {
    const snapshot = UsageSnapshotSchema.parse({
      accountId: "acct_personal_cursor",
      windows: [
        {
          kind: "five-hour",
          remainingRatio: 0.72,
          usedRatio: 0.28,
          resetsAt: "2026-09-17T14:00:00.000Z",
        },
        {
          kind: "daily",
          remainingRatio: 0.5,
          usedRatio: 0.5,
          resetsAt: "2026-09-18T00:00:00.000Z",
        },
        {
          kind: "weekly",
          remainingRatio: 0.8,
          usedRatio: 0.2,
          resetsAt: "2026-09-22T00:00:00.000Z",
        },
        {
          kind: "monthly",
          remainingRatio: 0.9,
          usedRatio: 0.1,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
        { kind: "provider-defined", remainingRatio: 0.6, usedRatio: 0.4 },
      ],
      collectedAt: "2026-09-17T09:00:00.000Z",
      source: "official-api",
      certainty: "exact",
      expiresAt: "2026-09-17T09:05:00.000Z",
      activeReservationRatio: 0.02,
    });

    expect(snapshot.windows.map((window) => window.kind)).toEqual([
      "five-hour",
      "daily",
      "weekly",
      "monthly",
      "provider-defined",
    ]);
    expect(snapshot.certainty).toBe("exact");
  });

  it("rejects remaining ratios outside 0..1", () => {
    expect(() =>
      UsageSnapshotSchema.parse({
        accountId: "acct_personal_cursor",
        windows: [{ kind: "daily", remainingRatio: 1.2 }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "local-session",
        certainty: "estimated",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
    ).toThrow();
  });
});

describe("ModelProfileSchema", () => {
  it("records supported reasoning efforts without inventing availability", () => {
    const profile = ModelProfileSchema.parse({
      id: "cursor:grok-4.6",
      provider: "cursor",
      agent: "cursor",
      launchName: "grok-4.6",
      supportedEfforts: ["low", "medium", "high"],
      capabilities: {
        planning: 0.9,
        coding: 0.85,
        debugging: 0.8,
        creativity: 0.7,
        research: 0.75,
      },
      relativeQuotaCost: 1,
      relativeLatency: 1,
    });

    expect(profile.supportedEfforts).toEqual(["low", "medium", "high"]);
    expect(profile.supportedEfforts).not.toContain("ultra");
  });

  it("rejects unsupported effort names", () => {
    expect(() =>
      ModelProfileSchema.parse({
        id: "cursor:grok-4.6",
        provider: "cursor",
        agent: "cursor",
        launchName: "grok-4.6",
        supportedEfforts: ["ludicrous"],
        capabilities: {
          planning: 1,
          coding: 1,
          debugging: 1,
          creativity: 1,
          research: 1,
        },
        relativeQuotaCost: 1,
        relativeLatency: 1,
      }),
    ).toThrow();
  });
});

describe("session and route schemas", () => {
  it("accepts a router session and closed-set route candidate", () => {
    const session = RouterSessionSchema.parse({
      id: "sess_1",
      task: "Implement the approved plan",
      phase: "implementation",
      reservations: [],
      handoffs: [],
      createdAt: "2026-09-17T09:00:00.000Z",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    const candidate = RouteCandidateSchema.parse({
      opaqueId: "cand_1",
      accountId: "acct_personal_cursor",
      modelId: "cursor:grok-4.6",
      agent: "cursor",
      supportedEfforts: ["medium", "high"],
      projectedRemainingRatio: 0.7,
    });
    const decision = RouteDecisionSchema.parse({
      candidateOpaqueId: "cand_1",
      accountId: "acct_personal_cursor",
      modelId: "cursor:grok-4.6",
      agent: "cursor",
      effort: "medium",
      confidence: 0.82,
      reason: "approved specification makes execution well-bounded",
    });

    expect(session.phase).toBe("implementation");
    expect(candidate.opaqueId).toBe("cand_1");
    expect(decision.effort).toBe("medium");
  });
});
