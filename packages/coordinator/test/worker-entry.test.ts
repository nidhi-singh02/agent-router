import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { LEASE_SQL } from "../src/schema.js";
import type { D1DatabaseLike, D1StatementLike } from "../src/leases.js";

function d1(db: Database.Database): D1DatabaseLike {
  return {
    prepare(sql: string): D1StatementLike {
      let values: unknown[] = [];
      return {
        bind(...next) {
          values = next;
          return this;
        },
        async run() {
          return db.prepare(sql).run(...values);
        },
        async first<T>() {
          return (db.prepare(sql).get(...values) as T | undefined) ?? null;
        },
      };
    },
  };
}

describe("deployed worker entry", () => {
  it("persists a lease across separate fetch calls through the D1 binding", async () => {
    const db = new Database(":memory:");
    db.exec(LEASE_SQL);
    const env = { WRITER_SECRET: "writer", READER_SECRET: "reader", LEASES: d1(db) };
    const created = await worker.fetch(
      new Request("https://coordinator.example/leases", {
        method: "POST",
        headers: { authorization: "Bearer writer", "content-type": "application/json" },
        body: JSON.stringify({ accountFingerprint: "fp", leaseId: "lease_1", ttlSeconds: 15 }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const status = await worker.fetch(
      new Request("https://coordinator.example/accounts/fp/status", {
        headers: { authorization: "Bearer reader" },
      }),
      env,
    );
    expect(await status.json()).toEqual({ activity: "active" });
    db.close();
  });
});
