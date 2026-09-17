import { UsageSnapshotSchema, type UsageSnapshot } from "../domain/usage.js";

export function redactCollectorText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function normalizeUsage(input: UsageSnapshot): UsageSnapshot {
  return UsageSnapshotSchema.parse({
    ...input,
    activeReservationRatio: input.activeReservationRatio ?? 0,
  });
}
