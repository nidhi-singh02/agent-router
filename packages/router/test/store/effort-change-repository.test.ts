import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { databasePath, migrate, openDatabase } from "../../src/store/database.js";
import { EffortChangeRepository } from "../../src/store/effort-change-repository.js";

function repo() {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-effort-repo-"));
  return new EffortChangeRepository(openDatabase({ home }));
}

describe("EffortChangeRepository", () => {
  it("upgrades a version 2 database in place", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "router-effort-migrate-"));
    openDatabase({ home }).close();
    const db = new Database(databasePath(home));
    db.exec("drop table effort_changes; drop table effort_locks;");
    db.pragma("user_version = 2");
    migrate(db);
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);
    expect(new EffortChangeRepository(db).listForSession("sess_x")).toEqual([]);
    db.close();
  });

  it("records changes in order and counts only applied agent switches", () => {
    const changes = repo();
    const base = {
      sessionId: "sess_a",
      from: "medium" as const,
      to: "high" as const,
      reason: "switched",
      turnBreak: false,
    };
    changes.record({
      ...base,
      source: "agent",
      status: "applied",
      createdAt: "2026-09-26T10:00:00.000Z",
      confidence: 0.8,
      signals: { stepKind: "debug" },
    });
    changes.record({
      ...base,
      source: "agent",
      status: "failed",
      reason: "pane-input-busy",
      createdAt: "2026-09-26T10:01:00.000Z",
    });
    changes.record({
      ...base,
      source: "manual",
      status: "applied",
      createdAt: "2026-09-26T10:02:00.000Z",
    });
    changes.record({
      ...base,
      sessionId: "sess_b",
      source: "agent",
      status: "applied",
      createdAt: "2026-09-26T10:03:00.000Z",
    });
    const listed = changes.listForSession("sess_a");
    expect(listed.map((change) => change.reason)).toEqual([
      "switched",
      "pane-input-busy",
      "switched",
    ]);
    expect(listed[0]).toMatchObject({ confidence: 0.8, signals: { stepKind: "debug" } });
    expect(listed[1]!.confidence).toBeUndefined();
    // The cap counts applied switches; the cooldown runs from the latest attempt, failed too.
    expect(changes.agentSwitchStats("sess_a")).toEqual({
      count: 1,
      lastAt: "2026-09-26T10:01:00.000Z",
    });
    expect(changes.agentSwitchStats("sess_none")).toEqual({ count: 0 });
  });

  it("holds a pane lock until released or expired", () => {
    const changes = repo();
    expect(changes.tryLock("wJ:p1", "one", 1_000, 60_000)).toBe(true);
    expect(changes.tryLock("wJ:p1", "two", 2_000, 60_000)).toBe(false);
    expect(changes.tryLock("wJ:p2", "two", 2_000, 60_000)).toBe(true);
    changes.unlock("wJ:p1", "two");
    expect(changes.tryLock("wJ:p1", "two", 2_000, 60_000)).toBe(false);
    changes.unlock("wJ:p1", "one");
    expect(changes.tryLock("wJ:p1", "two", 2_000, 60_000)).toBe(true);
    // An abandoned lock expires.
    expect(changes.tryLock("wJ:p1", "three", 2_000 + 60_000, 60_000)).toBe(true);
  });
});
