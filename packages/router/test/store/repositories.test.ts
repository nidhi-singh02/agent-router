import { chmodSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/database.js";
import { AccountRepository } from "../../src/store/account-repository.js";
import { AuditRepository } from "../../src/store/audit-repository.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { UsageRepository } from "../../src/store/usage-repository.js";

function openTestDb() {
  const home = mkdtempSync(path.join(os.tmpdir(), "model-router-db-"));
  return openDatabase({ home });
}

describe("sqlite store", () => {
  it("repairs private permissions for the state directory and database", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(path.join(os.tmpdir(), "model-router-private-"));
    chmodSync(home, 0o755);
    const db = openDatabase({ home });
    db.close();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(home, "state.sqlite")).mode & 0o777).toBe(0o600);
  });
  it("applies migrations idempotently and records a schema version", () => {
    const first = openTestDb();
    const version = Number(first.pragma("user_version", { simple: true }));
    first.close();
    expect(version).toBeGreaterThan(0);
    expect(first.name.endsWith("state.sqlite")).toBe(true);
  });

  it("can migrate the same database twice without error", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "model-router-db-"));
    const db1 = openDatabase({ home });
    const version1 = Number(db1.pragma("user_version", { simple: true }));
    db1.close();
    const db2 = openDatabase({ home });
    const version2 = Number(db2.pragma("user_version", { simple: true }));
    db2.close();
    expect(version1).toBeGreaterThan(0);
    expect(version2).toBe(version1);
  });

  it("stores credential references rather than secrets", () => {
    const db = openTestDb();
    const accounts = new AccountRepository(db);
    accounts.upsert({
      id: "acct_personal_cursor",
      label: "personal cursor",
      provider: "cursor",
      agent: "cursor",
      ownership: "personal",
      reserveFloor: 0,
      collectorPreference: ["official-cli"],
      enabledModels: ["cursor:grok-4.6"],
      enabled: true,
      credentialRef: "env:CURSOR_API_KEY",
    });
    const stored = accounts.get("acct_personal_cursor");
    expect(stored?.credentialRef).toBe("env:CURSOR_API_KEY");
    const dump = db.prepare("select * from accounts").all();
    expect(JSON.stringify(dump)).not.toMatch(/sk-live|secret_value/i);
    db.close();
  });

  it("recovers a persisted session", () => {
    const db = openTestDb();
    const sessions = new SessionRepository(db);
    sessions.save({
      id: "sess_1",
      task: "Implement the approved plan",
      phase: "implementation",
      reservations: [],
      handoffs: [],
      createdAt: "2026-09-17T09:00:00.000Z",
      updatedAt: "2026-09-17T09:00:00.000Z",
    });
    const recovered = sessions.get("sess_1");
    expect(recovered?.id).toBe("sess_1");
    expect(recovered?.phase).toBe("implementation");
    db.close();
  });

  it("lists sessions newest first and returns the latest", () => {
    const db = openTestDb();
    const sessions = new SessionRepository(db);
    for (const [id, at] of [
      ["sess_old", "2026-09-17T09:00:00.000Z"],
      ["sess_new", "2026-09-17T10:00:00.000Z"],
      ["sess_mid", "2026-09-17T09:30:00.000Z"],
    ] as const) {
      sessions.save({
        id,
        task: "task",
        phase: "implementation",
        reservations: [],
        handoffs: [],
        createdAt: at,
        updatedAt: at,
      });
    }
    expect(sessions.latest()?.id).toBe("sess_new");
    expect(sessions.list(2).map((session) => session.id)).toEqual(["sess_new", "sess_mid"]);
    db.close();
  });

  it("returns no latest session for an empty store", () => {
    const db = openTestDb();
    expect(new SessionRepository(db).latest()).toBeUndefined();
    expect(new SessionRepository(db).list(5)).toEqual([]);
    db.close();
  });

  it("stores redacted audit events without raw secrets", () => {
    const db = openTestDb();
    const audit = new AuditRepository(db);
    audit.record({
      kind: "route-decision",
      details: {
        questionId: "route",
        answer: "cand_1",
        confidence: 0.9,
        task: "fix the billing token sk-secret-123 in auth.ts",
        authorization: "Bearer sk-secret-123",
      },
    });
    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("sk-secret-123");
    expect(JSON.stringify(rows)).not.toContain("Bearer");
    db.close();
  });

  it("persists usage snapshots with certainty", () => {
    const db = openTestDb();
    const usage = new UsageRepository(db);
    usage.save({
      accountId: "acct_personal_cursor",
      windows: [{ kind: "five-hour" }],
      collectedAt: "2026-09-17T09:00:00.000Z",
      source: "official-cli",
      certainty: "unknown",
      expiresAt: "2026-09-17T09:05:00.000Z",
      activeReservationRatio: 0,
    });
    const snapshot = usage.latest("acct_personal_cursor");
    expect(snapshot?.certainty).toBe("unknown");
    expect(snapshot?.windows[0]?.remainingRatio).toBeUndefined();
    db.close();
  });
});
