/**
 * Database connection layer. Uses node:sqlite (embedded, zero-dependency demo).
 * The SQL schema (schema.sql) is the canonical model; the PostgreSQL deployment
 * profile uses the same DDL semantics (see docker-compose.yml --profile pg).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');

export function dbPathFromEnv(): string {
  const p = process.env.FINPILOT_DB_PATH || './data/finpilot.db';
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  const file = dbPathFromEnv();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new DatabaseSync(file);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  return _db;
}

/** Test helper: fresh in-memory database. */
export function getMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function runSchema(db: DatabaseSync): void {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(sql);
}

export interface Txn {
  db: DatabaseSync;
  committed: boolean;
  commit(): void;
  rollback(): void;
}

/** Simple transaction wrapper (SQLite serializes writes; adequate for demo durability). */
export function withTransaction<T>(db: DatabaseSync, fn: (txn: Txn) => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn({ db, committed: false, commit() { this.committed = true; }, rollback() { throw new Error('__rollback__'); } });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    if (err instanceof Error && err.message === '__rollback__') return undefined as unknown as T;
    throw err;
  }
  db.exec('COMMIT');
  return result;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const rnd = crypto.randomUUID().slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/** JSON parse with fallback. */
export function jparse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function jstring(v: unknown): string {
  return JSON.stringify(v ?? null);
}
