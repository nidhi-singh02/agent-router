import type { Account, CollectorKind } from "../domain/account.js";
import type { UsageSnapshot } from "../domain/usage.js";
import { normalizeUsage } from "./normalizer.js";
import type { UsageCollector } from "./types.js";

const PRIORITY: CollectorKind[] = [
  "official-api",
  "official-cli",
  "local-session",
  "browser-dashboard",
];

export async function collectUsageChain(
  account: Account,
  collectors: UsageCollector[],
): Promise<UsageSnapshot> {
  const ranked = [...collectors].sort(
    (left, right) => PRIORITY.indexOf(left.kind) - PRIORITY.indexOf(right.kind),
  );
  for (const collector of ranked) {
    try {
      const snapshot = normalizeUsage(await collector.collectUsage(account));
      if (snapshot.certainty !== "unknown") {
        return snapshot;
      }
    } catch {
      // Degrade to the next collector; never invent usage.
    }
  }
  const now = new Date().toISOString();
  return normalizeUsage({
    accountId: account.id,
    windows: [{ kind: "five-hour" }],
    collectedAt: now,
    source: "browser-dashboard",
    certainty: "unknown",
    expiresAt: now,
    activeReservationRatio: 0,
  });
}
