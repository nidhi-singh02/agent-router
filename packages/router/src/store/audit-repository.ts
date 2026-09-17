import type Database from "better-sqlite3";

export interface AuditEvent {
  kind: string;
  details: unknown;
  createdAt?: string;
}

function redactString(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "[REDACTED]");
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redact(nested)]));
  }
  return value;
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  record(event: AuditEvent): void {
    this.db
      .prepare(`insert into audit_events (kind, details, created_at) values (?, ?, ?)`)
      .run(
        event.kind,
        JSON.stringify(redact(event.details)),
        event.createdAt ?? new Date().toISOString(),
      );
  }

  list(): Array<{ kind: string; details: unknown; createdAt: string }> {
    const rows = this.db
      .prepare(`select kind, details, created_at as createdAt from audit_events order by id asc`)
      .all() as Array<{ kind: string; details: string; createdAt: string }>;
    return rows.map((row) => ({
      kind: row.kind,
      details: JSON.parse(row.details) as unknown,
      createdAt: row.createdAt,
    }));
  }
}
