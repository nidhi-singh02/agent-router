import type { UsageSnapshot } from "../domain/usage.js";

export function isFresh(snapshot: UsageSnapshot, now: Date): boolean {
  return Date.parse(snapshot.expiresAt) > now.getTime();
}
