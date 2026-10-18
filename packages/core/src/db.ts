import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(schema.DDL);
  // Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old files.
  const dealCols = sqlite.prepare('PRAGMA table_info(deals)').all() as { name: string }[];
  if (!dealCols.some((c) => c.name === 'channel_pref'))
    sqlite.exec("ALTER TABLE deals ADD COLUMN channel_pref TEXT NOT NULL DEFAULT 'auto'");
  if (!dealCols.some((c) => c.name === 'strategy'))
    sqlite.exec("ALTER TABLE deals ADD COLUMN strategy TEXT NOT NULL DEFAULT 'coach'");
  return drizzle(sqlite, { schema }) as DB;
}

export const now = () => new Date().toISOString();
