import { describe, expect, it } from "vitest";
import { collectUsageChain } from "../../src/collectors/collector-chain.js";
import type { UsageCollector } from "../../src/collectors/types.js";
import { AccountSchema } from "../../src/domain/account.js";
import { evaluateEligibility } from "../../src/policy/eligibility.js";
import { isFresh } from "../../src/policy/freshness.js";
import { cursorModel } from "../cli/fixtures.js";

const account = AccountSchema.parse({
  id: "acct_1",
  label: "personal",
  provider: "cursor",
  agent: "cursor",
  ownership: "personal",
  collectorPreference: ["official-cli", "local-session", "browser-dashboard"],
  enabledModels: ["cursor:grok-4.6"],
  enabled: true,
});

function collector(
  name: string,
  behavior: Partial<UsageCollector> & Pick<UsageCollector, "kind">,
): UsageCollector {
  return {
    detectAccounts: async () => [],
    listAvailableModels: async () => [],
    collectUsage: async () => {
      throw new Error(`${name} missing collectUsage`);
    },
    ...behavior,
  };
}

describe("collector chain", () => {
  it("prefers official API/CLI, then local session, then browser, then unknown", async () => {
    const order: string[] = [];
    const result = await collectUsageChain(account, [
      collector("browser", {
        kind: "browser-dashboard",
        collectUsage: async () => {
          order.push("browser-dashboard");
          return {
            accountId: account.id,
            windows: [{ kind: "five-hour", remainingRatio: 0.1 }],
            collectedAt: "2026-09-17T09:00:00.000Z",
            source: "browser-dashboard",
            certainty: "estimated",
            expiresAt: "2026-09-17T09:05:00.000Z",
            activeReservationRatio: 0,
          };
        },
      }),
      collector("cli", {
        kind: "official-cli",
        collectUsage: async () => {
          order.push("official-cli");
          return {
            accountId: account.id,
            windows: [{ kind: "five-hour", remainingRatio: 0.8 }],
            collectedAt: "2026-09-17T09:00:00.000Z",
            source: "official-cli",
            certainty: "exact",
            expiresAt: "2026-09-17T09:05:00.000Z",
            activeReservationRatio: 0,
          };
        },
      }),
      collector("session", {
        kind: "local-session",
        collectUsage: async () => {
          order.push("local-session");
          return {
            accountId: account.id,
            windows: [{ kind: "five-hour", remainingRatio: 0.5 }],
            collectedAt: "2026-09-17T09:00:00.000Z",
            source: "local-session",
            certainty: "estimated",
            expiresAt: "2026-09-17T09:05:00.000Z",
            activeReservationRatio: 0,
          };
        },
      }),
    ]);
    expect(order).toEqual(["official-cli"]);
    expect(result.source).toBe("official-cli");
    expect(result.certainty).toBe("exact");
  });

  it("degrades to the next collector when a command fails and never invents usage", async () => {
    const result = await collectUsageChain(account, [
      collector("cli", {
        kind: "official-cli",
        collectUsage: async () => {
          throw new Error("cli exploded");
        },
      }),
      collector("session", {
        kind: "local-session",
        collectUsage: async () => {
          throw new Error("session missing");
        },
      }),
    ]);
    expect(result.certainty).toBe("unknown");
    expect(result.windows[0]?.remainingRatio).toBeUndefined();
    expect(result.source).toBe("none");
  });

  it("keeps the unknown fallback fresh so personal accounts are not excluded as stale", async () => {
    const result = await collectUsageChain(account, [
      collector("cli", {
        kind: "official-cli",
        collectUsage: async () => {
          throw new Error("cli exploded");
        },
      }),
    ]);
    const now = new Date();
    expect(result.certainty).toBe("unknown");
    expect(isFresh(result, now)).toBe(true);
    expect(
      evaluateEligibility({
        account,
        model: cursorModel,
        usage: result,
        estimatedCostRatio: 0.1,
        now,
      }).eligible,
    ).toBe(true);
  });
});
