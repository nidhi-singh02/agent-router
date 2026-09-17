import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensureHome } from "../config/config-loader.js";

export interface OpenDatabaseOptions {
  home: string;
}

const CURRENT_SCHEMA_VERSION = 1;

export function databasePath(home: string): string {
  return path.join(home, "state.sqlite");
}

function migrationSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "migrations/001_initial.sql");
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf8");
  }
  return readFileSync(path.join(here, "../../src/store/migrations/001_initial.sql"), "utf8");
}

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  ensureHome(options.home);
  mkdirSync(options.home, { recursive: true });
  const db = new Database(databasePath(options.home));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  const apply = db.transaction(() => {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version >= CURRENT_SCHEMA_VERSION) {
      return;
    }
    db.exec(migrationSql());
    db.prepare("insert or ignore into schema_migrations (version, applied_at) values (?, ?)").run(
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    );
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  apply();
}
