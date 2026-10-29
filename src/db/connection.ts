import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SwarmError, errorMessage } from "../errors.js";
import { MIGRATIONS } from "./migrations.js";

export type SqliteDatabase = Database.Database;

export function openDatabase(filePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
    });
    try {
      run();
    } catch (error) {
      throw new SwarmError(
        `Migration ${migration.version} (${migration.name}) failed: ${errorMessage(error)}`,
        "migration",
      );
    }
  }
}

export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export function withBusyRetry<T>(fn: () => T, attempts = 5): T {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      last = error;
      if (!isBusyError(error) || attempt === attempts) break;
    }
  }
  throw new SwarmError(
    `SQLite remained busy after ${attempts} attempts: ${errorMessage(last)}`,
    "sqlite_busy",
    true,
  );
}
