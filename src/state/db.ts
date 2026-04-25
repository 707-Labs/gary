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
  return db;
}

function runSql(db: DB, sql: string): void {
  db.exec(sql);
}

function applySchema(db: DB): void {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

export function closeDb(db: DB): void {
  db.close();
}
