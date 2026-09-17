import type { UsageSnapshot, UsageWindow } from "../domain/usage.js";
import { windowsForPool } from "../policy/quota.js";

function windowText(window: UsageWindow): string | undefined {
  if (window.remainingRatio === undefined) {
    return undefined;
  }
  return `${window.pool ?? window.kind} ${Math.round(window.remainingRatio * 100)}% left`;
}

function known(windows: UsageWindow[]): string[] {
  return windows.map(windowText).filter((text): text is string => text !== undefined);
}

/** Quota for a decision: the model's pool first, other pools in parentheses. */
export function formatPoolQuota(snapshot: UsageSnapshot, pool?: string): string | undefined {
  if (snapshot.certainty === "unknown") {
    return undefined;
  }
  const primary = known(windowsForPool(snapshot, pool));
  if (primary.length === 0) {
    return undefined;
  }
  const others = pool
    ? known(snapshot.windows.filter((window) => window.pool && window.pool !== pool))
    : [];
  return others.length > 0 ? `${primary.join(", ")} (${others.join(", ")})` : primary.join(", ");
}

/** Quota for an account across every pool, with where and when it was read. */
export function formatAccountQuota(snapshot: UsageSnapshot): string {
  if (snapshot.source === "none") {
    return "unknown (no collector returned usage)";
  }
  const windows = snapshot.certainty === "unknown" ? [] : known(snapshot.windows);
  if (windows.length === 0) {
    return `unknown (${snapshot.source})`;
  }
  return `${windows.join(", ")} (${snapshot.certainty} ${snapshot.source}, as of ${snapshot.collectedAt})`;
}
