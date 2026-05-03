import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DB_DIR = process.env.AGENT_HQ_DATA_DIR ?? REPO_ROOT;
// AGENT_HQ_DB_PATH is preferred. DATABASE_PATH remains supported as a generic fallback.
const DB_PATH = process.env.AGENT_HQ_DB_PATH ?? process.env.DATABASE_PATH ?? path.join(DB_DIR, 'agent-hq.db');

// Ensure directory exists
const dbParentDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbParentDir)) {
  fs.mkdirSync(dbParentDir, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export default getDb;
