import { normalizeUsage } from "../normalizer.js";
import type { ModelAvailability } from "../types.js";
import type { UsageSnapshot } from "../../domain/usage.js";

export function parseCodexUsage(raw: string): {
  snapshot: UsageSnapshot;
  models: ModelAvailability[];
  credentialPresent: boolean;
  provider: "openai";
  diagnostic?: string;
} {
  try {
    const data = JSON.parse(raw) as {
      auth?: { present?: boolean };
      models?: Array<{ id: string }>;
      usage?: { windows?: Array<{ kind: string; remainingPercent?: number }> };
    };
    const remaining = data.usage?.windows?.[0]?.remainingPercent;
    return {
      provider: "openai",
      snapshot: normalizeUsage({
        accountId: "detected",
        windows: [
          {
            kind: "weekly",
            remainingRatio: remaining === undefined ? undefined : remaining / 100,
          },
        ],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: remaining === undefined ? "unknown" : "exact",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      models: (data.models ?? []).map((model) => ({
        modelId: `openai:${model.id}` as ModelAvailability["modelId"],
        launchName: model.id,
        available: true,
        source: "official-cli" as const,
      })),
      credentialPresent: Boolean(data.auth?.present),
    };
  } catch {
    return {
      provider: "openai",
      snapshot: normalizeUsage({
        accountId: "detected",
        windows: [{ kind: "weekly" }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "unknown",
        expiresAt: "2026-09-17T09:00:00.000Z",
        activeReservationRatio: 0,
      }),
      models: [],
      credentialPresent: false,
      diagnostic: "openai fixture is not valid JSON",
    };
  }
}
