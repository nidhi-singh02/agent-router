import { UsageSnapshotSchema, type UsageSnapshot } from "../domain/usage.js";

export function redactCollectorText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function normalizeUsage(input: {
  accountId: string;
  windows: UsageSnapshot["windows"];
  collectedAt: string;
  source: UsageSnapshot["source"];
  certainty: UsageSnapshot["certainty"];
  expiresAt: string;
  activeReservationRatio?: number;
}): UsageSnapshot {
  return UsageSnapshotSchema.parse({
    ...input,
    activeReservationRatio: input.activeReservationRatio ?? 0,
  });
}
