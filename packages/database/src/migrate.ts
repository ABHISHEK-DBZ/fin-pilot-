/**
 * Migration runner: creates the schema in the configured database.
 * Idempotent: CREATE TABLE IF NOT EXISTS + column-level ALTERs for tables that
 * predate a schema change (safe to run repeatedly on evolving databases).
 */
import { getDb, runSchema, dbPathFromEnv, DATA_DIR } from './db.ts';
import fs from 'node:fs';

/** Ensure a column exists on a table (for databases created before a schema change). */
function ensureColumn(db: import('node:sqlite').DatabaseSync, table: string, column: string, ddlType: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
    console.log(`[migrate] added column ${table}.${column}`);
  }
}

function main(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = getDb();
  runSchema(db);
  // columns added after the initial schema release
  ensureColumn(db, 'close_runs', 'cfo_summary_json', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const row = db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get() as unknown as { v: number | null };
  const v = (row?.v ?? 0) + 1;
  db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(v, new Date().toISOString());
  console.log(`[migrate] schema applied at ${dbPathFromEnv()}`);
}

main();
