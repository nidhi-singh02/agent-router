import { normalizeUsage } from "../normalizer.js";
import type { ModelAvailability } from "../types.js";
import type { UsageSnapshot } from "../../domain/usage.js";

export interface ProviderParseResult {
  snapshot: UsageSnapshot;
  models: ModelAvailability[];
  credentialPresent: boolean;
  diagnostic?: string;
  provider?: string;
}

function unknown(diagnostic: string): ProviderParseResult {
  const now = "2026-09-17T09:00:00.000Z";
  return {
    snapshot: normalizeUsage({
      accountId: "detected",
      windows: [{ kind: "five-hour" }],
      collectedAt: now,
      source: "official-cli",
      certainty: "unknown",
      expiresAt: now,
      activeReservationRatio: 0,
    }),
    models: [],
    credentialPresent: false,
    diagnostic,
  };
}

export function parseCursorUsage(raw: string): ProviderParseResult {
  try {
    const data = JSON.parse(raw) as {
      account?: { emailRedacted?: string };
      models?: Array<{ id: string }>;
      usage?: { windows?: Array<{ kind: string; usedPercent?: number }> };
    };
    const used = data.usage?.windows?.[0]?.usedPercent;
    if (used === undefined) {
      return unknown("cursor usage window missing");
    }
    return {
      snapshot: normalizeUsage({
        accountId: "detected",
        windows: [{ kind: "five-hour", remainingRatio: (100 - used) / 100, usedRatio: used / 100 }],
        collectedAt: "2026-09-17T09:00:00.000Z",
        source: "official-cli",
        certainty: "exact",
        expiresAt: "2026-09-17T09:05:00.000Z",
        activeReservationRatio: 0,
      }),
      models: (data.models ?? []).map((model) => ({
        modelId: `cursor:${model.id}` as ModelAvailability["modelId"],
        launchName: model.id,
        available: true,
        source: "official-cli" as const,
      })),
      credentialPresent: Boolean(data.account?.emailRedacted),
    };
  } catch {
    return unknown("cursor fixture is not valid JSON");
  }
}
