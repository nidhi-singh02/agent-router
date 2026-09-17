import type { UsageSnapshot, UsageWindow } from "../domain/usage.js";

export function windowsForPool(snapshot: UsageSnapshot, pool?: string): UsageWindow[] {
  return snapshot.windows.filter((window) => !pool || !window.pool || window.pool === pool);
}

export function remainingRatio(snapshot: UsageSnapshot, pool?: string): number | undefined {
  if (snapshot.certainty === "unknown") {
    return undefined;
  }
  const remaining = windowsForPool(snapshot, pool).map((window) => window.remainingRatio);
  if (remaining.length === 0 || remaining.some((value) => value === undefined)) {
    return undefined;
  }
  return Math.min(...(remaining as number[]));
}

export function projectedRemainingRatio(
  snapshot: UsageSnapshot,
  estimatedCostRatio: number,
  pool?: string,
): number | undefined {
  const mostRestrictive = remainingRatio(snapshot, pool);
  if (mostRestrictive === undefined) {
    return undefined;
  }
  return mostRestrictive - snapshot.activeReservationRatio - estimatedCostRatio;
}
