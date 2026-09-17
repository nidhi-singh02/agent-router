import { normalizeUsage } from "../../normalizer.js";
import type { UsageSnapshot } from "../../../domain/usage.js";

export function parseOpenaiDashboard(html: string): { snapshot: UsageSnapshot; fragile: true } {
  const match = html.match(/Usage:\s*(\d+)% remaining/i);
  const remaining = match?.[1] ? Number(match[1]) / 100 : undefined;
  return {
    fragile: true,
    snapshot: normalizeUsage({
      accountId: "detected",
      windows: [{ kind: "provider-defined", remainingRatio: remaining }],
      collectedAt: "2026-09-17T09:00:00.000Z",
      source: "browser-dashboard",
      certainty: remaining === undefined ? "unknown" : "estimated",
      expiresAt: "2026-09-17T09:02:00.000Z",
      activeReservationRatio: 0,
    }),
  };
}
