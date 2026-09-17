import type Database from "better-sqlite3";
import { UsageSnapshotSchema, type UsageSnapshot } from "../domain/usage.js";

export class UsageRepository {
  constructor(private readonly db: Database.Database) {}

  save(snapshot: UsageSnapshot): void {
    this.db
      .prepare(
        `insert or replace into usage_snapshots (account_id, collected_at, payload) values (?, ?, ?)`,
      )
      .run(snapshot.accountId, snapshot.collectedAt, JSON.stringify(snapshot));
  }

  latest(accountId: string): UsageSnapshot | undefined {
    const row = this.db
      .prepare(
        `select payload from usage_snapshots where account_id = ? order by collected_at desc limit 1`,
      )
      .get(accountId) as { payload: string } | undefined;
    if (!row) {
      return undefined;
    }
    return UsageSnapshotSchema.parse(JSON.parse(row.payload));
  }
}
