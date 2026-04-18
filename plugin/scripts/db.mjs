#!/usr/bin/env node
/**
 * Thin SQLite helper used by plugin commands/hooks/skills.
 *
 * Opens the same `store/messages.db` that the core NanoClaw runtime uses.
 * Adds plugin-only tables (`outbox`, `tick_log`) via lazy migration so the
 * core schema from `src/db.ts` stays untouched.
 *
 * Exports:
 *   openDb()              → Database instance
 *   migratePluginSchema() → run idempotent plugin migrations
 *   outbox helpers, tick_log helpers, pending-message helpers.
 *
 * CLI usage:
 *   node db.mjs migrate            (apply plugin schema)
 *   node db.mjs pending <botName>  (JSON-print pending messages per group)
 *   node db.mjs outbox-pending     (JSON-print undelivered outbox rows)
 *   node db.mjs outbox-deliver <id> [error]  (mark row delivered or failed)
 *   node db.mjs outbox-enqueue <chatJid> <text>   (enqueue for delivery)
 *   node db.mjs tick-start         (insert tick_log row, print id)
 *   node db.mjs tick-end <id> <msgs> [err]  (close tick_log row)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB_PATH = path.resolve(
  process.env.NANOCLAW_PROJECT_ROOT || process.cwd(),
  'store',
  'messages.db',
);

export function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migratePluginSchema(db);
  return db;
}

export function migratePluginSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS tick_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      groups_processed INTEGER DEFAULT 0,
      messages_handled INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tick_started ON tick_log(started_at);

    CREATE TABLE IF NOT EXISTS wiki_pages (
      group_folder TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, name)
    );

    CREATE TABLE IF NOT EXISTS daemon_state (
      name TEXT PRIMARY KEY,
      pid INTEGER,
      port INTEGER,
      status TEXT,
      started_at TEXT,
      error TEXT
    );
  `);
}

// --- Outbox helpers ----------------------------------------------------------

export function enqueueOutbox(db, chatJid, text) {
  const info = db
    .prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at) VALUES (?, ?, 'pending', ?)`,
    )
    .run(chatJid, text, new Date().toISOString());
  return info.lastInsertRowid;
}

export function getPendingOutbox(db, limit = 50) {
  return db
    .prepare(
      `SELECT id, chat_jid, text, attempts FROM outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
    )
    .all(limit);
}

export function markOutboxDelivered(db, id) {
  db.prepare(
    `UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

export function markOutboxFailed(db, id, error) {
  db.prepare(
    `UPDATE outbox SET status = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
                       attempts = attempts + 1,
                       error = ? WHERE id = ?`,
  ).run(error, id);
}

// --- Pending inbound ---------------------------------------------------------

/**
 * Returns one row per registered group that has inbound messages newer than
 * its cursor. Rows include a message_count and the latest message timestamp.
 * Uses the existing `router_state` key `last_agent_timestamp` (JSON map).
 */
export function getGroupsWithPending(db, botName) {
  const registered = db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main
       FROM registered_groups`,
    )
    .all();

  const cursorRow = db
    .prepare(`SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`)
    .get();
  let cursors = {};
  try {
    cursors = cursorRow ? JSON.parse(cursorRow.value) : {};
  } catch {
    cursors = {};
  }

  const results = [];
  for (const g of registered) {
    const cursor = cursors[g.jid] || '';
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c, MAX(timestamp) AS max_ts
         FROM messages
         WHERE chat_jid = ? AND timestamp > ?
           AND is_bot_message = 0 AND content NOT LIKE ?
           AND content != '' AND content IS NOT NULL`,
      )
      .get(g.jid, cursor, `${botName}:%`);
    if (row.c > 0) {
      results.push({
        jid: g.jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger_pattern,
        requiresTrigger: g.requires_trigger !== 0,
        isMain: g.is_main === 1,
        messageCount: row.c,
        latestTimestamp: row.max_ts,
        cursor,
      });
    }
  }
  return results;
}

export function getMessagesSince(db, chatJid, sinceTimestamp, botName, limit = 50) {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
                reply_to_message_id, reply_to_message_content, reply_to_sender_name
         FROM messages
         WHERE chat_jid = ? AND timestamp > ?
           AND is_bot_message = 0 AND content NOT LIKE ?
           AND content != '' AND content IS NOT NULL
         ORDER BY timestamp DESC
         LIMIT ?
       ) ORDER BY timestamp`,
    )
    .all(chatJid, sinceTimestamp, `${botName}:%`, limit);
  return rows;
}

export function advanceCursor(db, chatJid, newTimestamp) {
  const row = db
    .prepare(`SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`)
    .get();
  let cursors = {};
  try {
    cursors = row ? JSON.parse(row.value) : {};
  } catch {
    cursors = {};
  }
  cursors[chatJid] = newTimestamp;
  db.prepare(
    `INSERT INTO router_state (key, value) VALUES ('last_agent_timestamp', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(cursors));
}

// --- Tick log ----------------------------------------------------------------

export function startTick(db) {
  const info = db
    .prepare(`INSERT INTO tick_log (started_at, status) VALUES (?, 'running')`)
    .run(new Date().toISOString());
  return info.lastInsertRowid;
}

export function endTick(db, id, { groupsProcessed = 0, messagesHandled = 0, error = null } = {}) {
  db.prepare(
    `UPDATE tick_log SET ended_at = ?, groups_processed = ?, messages_handled = ?,
                         status = CASE WHEN ? IS NULL THEN 'ok' ELSE 'error' END,
                         error = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    groupsProcessed,
    messagesHandled,
    error,
    error,
    id,
  );
}

// --- CLI entrypoint ----------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = openDb();

  switch (cmd) {
    case 'migrate':
      console.log('plugin schema migrated');
      break;
    case 'pending': {
      const botName = rest[0] || process.env.ASSISTANT_NAME || 'Andy';
      console.log(JSON.stringify(getGroupsWithPending(db, botName), null, 2));
      break;
    }
    case 'pending-messages': {
      const [jid, cursor = '', botName = 'Andy', limit = '50'] = rest;
      if (!jid) {
        console.error('usage: db.mjs pending-messages <jid> [cursor] [botName] [limit]');
        process.exit(1);
      }
      console.log(
        JSON.stringify(
          getMessagesSince(db, jid, cursor, botName, parseInt(limit, 10)),
          null,
          2,
        ),
      );
      break;
    }
    case 'advance-cursor': {
      const [jid, ts] = rest;
      if (!jid || !ts) {
        console.error('usage: db.mjs advance-cursor <jid> <timestamp>');
        process.exit(1);
      }
      advanceCursor(db, jid, ts);
      console.log('ok');
      break;
    }
    case 'outbox-enqueue': {
      const [jid, ...textParts] = rest;
      const text = textParts.join(' ');
      if (!jid || !text) {
        console.error('usage: db.mjs outbox-enqueue <jid> <text>');
        process.exit(1);
      }
      const id = enqueueOutbox(db, jid, text);
      console.log(String(id));
      break;
    }
    case 'outbox-pending':
      console.log(JSON.stringify(getPendingOutbox(db), null, 2));
      break;
    case 'outbox-deliver': {
      const [id, err] = rest;
      if (err) markOutboxFailed(db, Number(id), err);
      else markOutboxDelivered(db, Number(id));
      console.log('ok');
      break;
    }
    case 'tick-start':
      console.log(String(startTick(db)));
      break;
    case 'tick-end': {
      const [id, groups = '0', msgs = '0', err] = rest;
      endTick(db, Number(id), {
        groupsProcessed: Number(groups),
        messagesHandled: Number(msgs),
        error: err || null,
      });
      console.log('ok');
      break;
    }
    case 'status':
      console.log(
        JSON.stringify(
          {
            outbox: {
              pending: db
                .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'`)
                .get().c,
              delivered: db
                .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'delivered'`)
                .get().c,
              failed: db
                .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'failed'`)
                .get().c,
            },
            groups: db
              .prepare(`SELECT COUNT(*) AS c FROM registered_groups`)
              .get().c,
            lastTick: db
              .prepare(`SELECT * FROM tick_log ORDER BY id DESC LIMIT 1`)
              .get(),
            daemons: db.prepare(`SELECT * FROM daemon_state`).all(),
          },
          null,
          2,
        ),
      );
      break;
    default:
      console.error(
        `Unknown command: ${cmd}\n` +
          'Commands: migrate | pending | pending-messages | advance-cursor |\n' +
          '          outbox-enqueue | outbox-pending | outbox-deliver |\n' +
          '          tick-start | tick-end | status',
      );
      process.exit(1);
  }
}

// Only run CLI when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
