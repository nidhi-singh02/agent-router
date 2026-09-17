import { normalizeUsage } from "../normalizer.js";
import type { ModelAvailability } from "../types.js";
import type { UsageSnapshot } from "../../domain/usage.js";

export function parseClaudeUsage(raw: string): {
  snapshot: UsageSnapshot;
  models: ModelAvailability[];
  credentialPresent: boolean;
  diagnostic?: string;
} {
  try {
    const data = JSON.parse(raw) as {
      loggedIn?: boolean;
      models?: Array<{ id: string }>;
      usage?: { fiveHour?: number | null; weeklyUsedPercent?: number };
    };
    const weeklyUsed = data.usage?.weeklyUsedPercent;
    return {
      snapshot: normalizeUsage({
        accountId: "detected",
        windows: [
          { kind: "five-hour" },
          weeklyUsed === undefined
            ? { kind: "weekly" }
            : {
                kind: "weekly",
                usedRatio: weeklyUsed / 100,
                remainingRatio: (100 - weeklyUsed) / 100,
              },
        ],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "estimated",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      models: (data.models ?? []).map((model) => ({
        modelId: `anthropic:${model.id}` as ModelAvailability["modelId"],
        launchName: model.id,
        available: true,
        source: "official-cli" as const,
      })),
      credentialPresent: Boolean(data.loggedIn),
      diagnostic: "five-hour window not exposed; weekly usage is estimated from the fixture",
    };
  } catch {
    return {
      snapshot: normalizeUsage({
        accountId: "detected",
        windows: [{ kind: "five-hour" }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "unknown",
        expiresAt: "2026-09-17T09:00:00.000Z",
        activeReservationRatio: 0,
      }),
      models: [],
      credentialPresent: false,
      diagnostic: "anthropic fixture is not valid JSON",
    };
  }
}
