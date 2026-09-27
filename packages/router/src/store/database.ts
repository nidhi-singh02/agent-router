import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensureHome } from "../config/config-loader.js";

export interface OpenDatabaseOptions {
  home: string;
}

const CURRENT_SCHEMA_VERSION = 3;

const MIGRATIONS: Record<number, string> = {
  1: "001_initial.sql",
  2: "002_capacity_reservations.sql",
  3: "003_live_effort.sql",
};

export function databasePath(home: string): string {
  return path.join(home, "state.sqlite");
}

function migrationSql(version: number): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const name = MIGRATIONS[version];
  if (!name) throw new Error(`No migration for schema version ${version}`);
  const candidate = path.join(here, `migrations/${name}`);
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf8");
  }
  return readFileSync(path.join(here, `../../src/store/migrations/${name}`), "utf8");
}

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  ensureHome(options.home);
  const file = databasePath(options.home);
  const db = new Database(file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  db.pragma("journal_mode = WAL");
  if (process.platform !== "win32") {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`])
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  const apply = db.transaction(() => {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version >= CURRENT_SCHEMA_VERSION) return;
    for (let next = version + 1; next <= CURRENT_SCHEMA_VERSION; next += 1) {
      db.exec(migrationSql(next));
      db.prepare("insert or ignore into schema_migrations (version, applied_at) values (?, ?)").run(
        next,
        new Date().toISOString(),
      );
    }
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  apply();
}
