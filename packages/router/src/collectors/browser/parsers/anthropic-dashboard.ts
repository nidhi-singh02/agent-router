import { normalizeUsage } from "../../normalizer.js";
import type { UsageSnapshot } from "../../../domain/usage.js";

export function parseAnthropicDashboard(html: string): { snapshot: UsageSnapshot; fragile: true } {
  const weekly = html.match(/Weekly remaining (\d+)%/i);
  return {
    fragile: true,
    snapshot: normalizeUsage({
      accountId: "detected",
      windows: [
        { kind: "five-hour" },
        weekly?.[1]
          ? { kind: "weekly", remainingRatio: Number(weekly[1]) / 100 }
          : { kind: "weekly" },
      ],
      collectedAt: "2026-09-17T09:00:00.000Z",
      source: "browser-dashboard",
      certainty: "estimated",
      expiresAt: "2026-09-17T09:02:00.000Z",
      activeReservationRatio: 0,
    }),
  };
}
