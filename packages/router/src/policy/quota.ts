import type { UsageSnapshot } from "../domain/usage.js";

export function projectedRemainingRatio(
  snapshot: UsageSnapshot,
  estimatedCostRatio: number,
): number | undefined {
  if (snapshot.certainty === "unknown") {
    return undefined;
  }
  const remaining = snapshot.windows.map((window) => window.remainingRatio);
  if (remaining.some((value) => value === undefined)) {
    return undefined;
  }
  const mostRestrictive = Math.min(...(remaining as number[]));
  return mostRestrictive - snapshot.activeReservationRatio - estimatedCostRatio;
}
