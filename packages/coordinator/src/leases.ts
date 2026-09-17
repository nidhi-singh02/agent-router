export interface LeaseRecord {
  accountFingerprint: string;
  state: "active";
  modelFamily?: string;
  reservedCapacity?: number;
  lastSeenAt: string;
  expiresAt: string;
}

export type Activity = "inactive" | "active" | "constrained";

export function createLease(
  store: Map<string, LeaseRecord>,
  input: {
    accountFingerprint: string;
    ttlSeconds: number;
    maxTtlSeconds: number;
    modelFamily?: string;
    reservedCapacity?: number;
    now: number;
  },
): { ok: true; record: LeaseRecord } | { ok: false; error: string } {
  if (
    !input.accountFingerprint ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > input.maxTtlSeconds
  ) {
    return { ok: false, error: "malformed lease request" };
  }
  const record: LeaseRecord = {
    accountFingerprint: input.accountFingerprint,
    state: "active",
    modelFamily: input.modelFamily,
    reservedCapacity: input.reservedCapacity,
    lastSeenAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + input.ttlSeconds * 1000).toISOString(),
  };
  store.set(input.accountFingerprint, record);
  return { ok: true, record };
}

export function expireLeases(store: Map<string, LeaseRecord>, now: number): void {
  for (const [key, record] of store) {
    if (Date.parse(record.expiresAt) <= now) {
      store.delete(key);
    }
  }
}

export function normalizedActivity(record: LeaseRecord | undefined): Activity {
  if (!record) {
    return "inactive";
  }
  if ((record.reservedCapacity ?? 0) >= 0.2) {
    return "constrained";
  }
  return "active";
}
