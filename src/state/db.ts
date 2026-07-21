import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

export type DB = Database;

export function openDb(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });
  runSql(db, "PRAGMA journal_mode = WAL");
  runSql(db, "PRAGMA foreign_keys = ON");
  applySchema(db);
  applyMigrations(db);
  return db;
}

function runSql(db: DB, sql: string): void {
  db.exec(sql);
}

function applySchema(db: DB): void {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

/**
 * Idempotent column adds for tables that pre-date the column's existence in
 * `schema.sql`. SQLite's `CREATE TABLE IF NOT EXISTS` doesn't reconcile new
 * columns against the existing definition, so we ALTER explicitly when a
 * column is missing. Cheap; runs once per open and is a no-op on fresh DBs.
 */
function applyMigrations(db: DB): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  if (!cols.has("provider")) {
    db.exec("ALTER TABLE actions ADD COLUMN provider TEXT");
  }
  if (!cols.has("model")) {
    db.exec("ALTER TABLE actions ADD COLUMN model TEXT");
  }
  const ticketCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  if (!ticketCols.has("classification_type")) {
    db.exec("ALTER TABLE tickets ADD COLUMN classification_type TEXT");
  }
  const reviewCols = new Set(
    (db.prepare("PRAGMA table_info(review_passes)").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  // Pre-split rows all came from the single reviewer, whose mandate is what
  // the correctness role now carries — so backfilling them to 'correctness'
  // keeps historical calibration queries comparable to new ones.
  if (!reviewCols.has("role")) {
    db.exec(
      "ALTER TABLE review_passes ADD COLUMN role TEXT NOT NULL DEFAULT 'correctness'",
    );
  }
}

export function closeDb(db: DB): void {
  db.close();
}
