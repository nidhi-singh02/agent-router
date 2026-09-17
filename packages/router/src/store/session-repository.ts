import type Database from "better-sqlite3";
import { RouterSessionSchema, type RouterSession } from "../domain/session.js";

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  save(session: RouterSession): void {
    const parsed = RouterSessionSchema.parse(session);
    this.db
      .prepare(`insert or replace into sessions (id, payload, updated_at) values (?, ?, ?)`)
      .run(parsed.id, JSON.stringify(parsed), parsed.updatedAt);
  }

  get(id: string): RouterSession | undefined {
    const row = this.db.prepare(`select payload from sessions where id = ?`).get(id) as
      { payload: string } | undefined;
    if (!row) {
      return undefined;
    }
    return RouterSessionSchema.parse(JSON.parse(row.payload));
  }

  list(limit: number): RouterSession[] {
    const rows = this.db
      .prepare(`select payload from sessions order by updated_at desc, rowid desc limit ?`)
      .all(limit) as { payload: string }[];
    return rows.map((row) => RouterSessionSchema.parse(JSON.parse(row.payload)));
  }

  latest(): RouterSession | undefined {
    return this.list(1)[0];
  }
}
