/**
 * Shared test helpers. Not shipped — referenced only by *.test.mjs files.
 *
 * Centralizes the core sqlite schema setup so plugin tests don't each carry
 * their own copy of `src/db.ts` table definitions.
 */
import Database from 'better-sqlite3';
import { migratePluginSchema } from './db.mjs';

/**
 * Minimal slice of src/db.ts schema needed by plugin tests. Keep in sync
 * when src/db.ts changes a column the plugin relies on.
 */
export const CORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
    content TEXT, timestamp TEXT, is_from_me INTEGER,
    is_bot_message INTEGER DEFAULT 0,
    reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT,
    PRIMARY KEY (id, chat_jid)
  );
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TEXT,
    channel TEXT,
    is_group INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY, name TEXT, folder TEXT UNIQUE,
    trigger_pattern TEXT, added_at TEXT,
    requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS router_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    group_folder TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY, group_folder TEXT, chat_jid TEXT,
    prompt TEXT, script TEXT, schedule_type TEXT, schedule_value TEXT,
    context_mode TEXT DEFAULT 'isolated',
    next_run TEXT, last_run TEXT, last_result TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS task_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, run_at TEXT,
    duration_ms INTEGER, status TEXT, result TEXT, error TEXT
  );
`;

/**
 * Returns an in-memory Database with both core schema and plugin migrations
 * applied. Use in tests that need a realistic DB.
 */
export function makeTestDb() {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  migratePluginSchema(db);
  return db;
}

/**
 * Applies the core schema to a given db. Use when the caller wants to pass
 * a custom file path or pragma settings.
 */
export function applyCoreSchema(db) {
  db.exec(CORE_SCHEMA_SQL);
  return db;
}

export function registerGroupFixture(db, jid, opts = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups
      (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    opts.name || opts.folder || jid,
    opts.folder || jid,
    opts.trigger || '@Andy',
    new Date().toISOString(),
    opts.requiresTrigger === false ? 0 : 1,
    opts.isMain ? 1 : 0,
  );
}

export function seedMessageFixture(db, chatJid, timestamp, content, opts = {}) {
  db.prepare(
    `INSERT INTO messages
      (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id || `${chatJid}-${timestamp}-${Math.random()}`,
    chatJid,
    opts.sender || 'user',
    opts.senderName || 'User',
    content,
    timestamp,
    opts.isFromMe ? 1 : 0,
    opts.isBot ? 1 : 0,
  );
}
