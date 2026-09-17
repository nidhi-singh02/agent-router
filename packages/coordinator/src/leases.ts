export interface LeaseRecord {
  accountFingerprint: string;
  leaseId: string;
  state: "active";
  modelFamily?: string;
  reservedCapacity?: number;
  lastSeenAt: string;
  expiresAt: string;
}
export type Activity = "inactive" | "active" | "constrained";
export interface LeaseInput {
  accountFingerprint: string;
  leaseId: string;
  ttlSeconds: number;
  maxTtlSeconds: number;
  modelFamily?: string;
  reservedCapacity?: number;
  now: number;
}
export interface LeaseRepository {
  create(input: LeaseInput): Promise<{ ok: true } | { ok: false; error: string }>;
  renew(input: LeaseInput): Promise<{ ok: true } | { ok: false; error: string }>;
  release(accountFingerprint: string, leaseId: string): Promise<void>;
  activity(accountFingerprint: string, now: number): Promise<Activity>;
}
function valid(input: LeaseInput): boolean {
  return Boolean(
    /^[A-Za-z0-9._-]{1,128}$/.test(input.accountFingerprint) &&
    /^[A-Za-z0-9._-]{1,128}$/.test(input.leaseId) &&
    Number.isFinite(input.ttlSeconds) &&
    input.ttlSeconds > 0 &&
    input.ttlSeconds <= input.maxTtlSeconds &&
    (input.reservedCapacity === undefined ||
      (Number.isFinite(input.reservedCapacity) &&
        input.reservedCapacity >= 0 &&
        input.reservedCapacity <= 1)),
  );
}
function record(input: LeaseInput): LeaseRecord {
  return {
    accountFingerprint: input.accountFingerprint,
    leaseId: input.leaseId,
    state: "active",
    modelFamily: input.modelFamily,
    reservedCapacity: input.reservedCapacity,
    lastSeenAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + input.ttlSeconds * 1000).toISOString(),
  };
}

export class InMemoryLeaseRepository implements LeaseRepository {
  private readonly records = new Map<string, LeaseRecord>();
  async create(input: LeaseInput) {
    if (!valid(input)) return { ok: false as const, error: "malformed lease request" };
    this.records.set(`${input.accountFingerprint}:${input.leaseId}`, record(input));
    return { ok: true as const };
  }
  async renew(input: LeaseInput) {
    if (!valid(input)) return { ok: false as const, error: "malformed lease request" };
    const key = `${input.accountFingerprint}:${input.leaseId}`;
    const prior = this.records.get(key);
    if (!prior) return { ok: false as const, error: "lease not found" };
    this.records.set(key, {
      ...prior,
      lastSeenAt: new Date(input.now).toISOString(),
      expiresAt: new Date(input.now + input.ttlSeconds * 1000).toISOString(),
    });
    return { ok: true as const };
  }
  async release(accountFingerprint: string, leaseId: string) {
    this.records.delete(`${accountFingerprint}:${leaseId}`);
  }
  async activity(accountFingerprint: string, now: number): Promise<Activity> {
    const active = [...this.records.values()].filter(
      (item) => item.accountFingerprint === accountFingerprint && Date.parse(item.expiresAt) > now,
    );
    for (const [key, item] of this.records)
      if (Date.parse(item.expiresAt) <= now) this.records.delete(key);
    if (active.length === 0) return "inactive";
    return active.some((item) => (item.reservedCapacity ?? 0) >= 0.2) ? "constrained" : "active";
  }
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
}
export class D1LeaseRepository implements LeaseRepository {
  constructor(private readonly db: D1DatabaseLike) {}
  async create(input: LeaseInput) {
    if (!valid(input)) return { ok: false as const, error: "malformed lease request" };
    const item = record(input);
    await this.db
      .prepare(
        "INSERT INTO leases (account_fingerprint, lease_id, state, model_family, reserved_capacity, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_fingerprint, lease_id) DO UPDATE SET state=excluded.state, model_family=excluded.model_family, reserved_capacity=excluded.reserved_capacity, last_seen_at=excluded.last_seen_at, expires_at=excluded.expires_at",
      )
      .bind(
        item.accountFingerprint,
        item.leaseId,
        item.state,
        item.modelFamily ?? null,
        item.reservedCapacity ?? null,
        item.lastSeenAt,
        item.expiresAt,
      )
      .run();
    return { ok: true as const };
  }
  async renew(input: LeaseInput) {
    if (!valid(input)) return { ok: false as const, error: "malformed lease request" };
    const existing = await this.db
      .prepare("SELECT lease_id FROM leases WHERE account_fingerprint = ? AND lease_id = ?")
      .bind(input.accountFingerprint, input.leaseId)
      .first();
    if (!existing) return { ok: false as const, error: "lease not found" };
    await this.db
      .prepare(
        "UPDATE leases SET last_seen_at = ?, expires_at = ? WHERE account_fingerprint = ? AND lease_id = ?",
      )
      .bind(
        new Date(input.now).toISOString(),
        new Date(input.now + input.ttlSeconds * 1000).toISOString(),
        input.accountFingerprint,
        input.leaseId,
      )
      .run();
    return { ok: true as const };
  }
  async release(accountFingerprint: string, leaseId: string) {
    await this.db
      .prepare("DELETE FROM leases WHERE account_fingerprint = ? AND lease_id = ?")
      .bind(accountFingerprint, leaseId)
      .run();
  }
  async activity(accountFingerprint: string, now: number): Promise<Activity> {
    const at = new Date(now).toISOString();
    await this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").bind(at).run();
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count, MAX(COALESCE(reserved_capacity, 0)) AS max_reserved FROM leases WHERE account_fingerprint = ? AND expires_at > ?",
      )
      .bind(accountFingerprint, at)
      .first<{ count: number; max_reserved: number | null }>();
    if (!row || Number(row.count) === 0) return "inactive";
    return Number(row.max_reserved ?? 0) >= 0.2 ? "constrained" : "active";
  }
}
