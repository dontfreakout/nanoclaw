/**
 * Tests for plugin/scripts/db.mjs
 *
 * Run with: npx vitest run plugin/scripts/db.test.mjs
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migratePluginSchema,
  enqueueOutbox,
  getPendingOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  getGroupsWithPending,
  getMessagesSince,
  advanceCursor,
  startTick,
  endTick,
} from './db.mjs';

function coreSchema(db) {
  // minimal slice of src/db.ts schema needed by plugin helpers
  db.exec(`
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT, is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT, folder TEXT,
      trigger_pattern TEXT, added_at TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    );
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
  `);
}

function seedGroup(db, jid, opts = {}) {
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    opts.name || jid,
    opts.folder || jid,
    opts.trigger || '@Andy',
    new Date().toISOString(),
    opts.requiresTrigger === false ? 0 : 1,
    opts.isMain ? 1 : 0,
  );
}

function seedMessage(db, chatJid, ts, content, opts = {}) {
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id || `${ts}-${Math.random()}`,
    chatJid,
    opts.sender || 'user',
    opts.senderName || 'User',
    content,
    ts,
    opts.isFromMe ? 1 : 0,
    opts.isBot ? 1 : 0,
  );
}

describe('plugin db helpers', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  describe('outbox', () => {
    it('enqueues a message and returns it as pending', () => {
      const id = enqueueOutbox(db, 'chat1@g.us', 'hello');
      const pending = getPendingOutbox(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(id);
      expect(pending[0].chat_jid).toBe('chat1@g.us');
      expect(pending[0].text).toBe('hello');
    });

    it('marks rows delivered', () => {
      const id = enqueueOutbox(db, 'chat1@g.us', 'hi');
      markOutboxDelivered(db, id);
      expect(getPendingOutbox(db)).toHaveLength(0);
      const row = db
        .prepare('SELECT status, delivered_at FROM outbox WHERE id = ?')
        .get(id);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).toBeTruthy();
    });

    it('marks rows failed after 5 attempts', () => {
      const id = enqueueOutbox(db, 'chat1@g.us', 'hi');
      for (let i = 0; i < 5; i++) markOutboxFailed(db, id, `try ${i}`);
      const row = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(id);
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(5);
    });

    it('keeps rows pending before 5 attempts', () => {
      const id = enqueueOutbox(db, 'chat1@g.us', 'hi');
      markOutboxFailed(db, id, 'try 1');
      const row = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(id);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
    });
  });

  describe('pending groups', () => {
    it('returns only groups with new messages', () => {
      seedGroup(db, 'g1@g.us', { folder: 'g1' });
      seedGroup(db, 'g2@g.us', { folder: 'g2' });
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:01Z', 'hello');
      // g2 has no messages
      const pending = getGroupsWithPending(db, 'Andy');
      expect(pending).toHaveLength(1);
      expect(pending[0].jid).toBe('g1@g.us');
      expect(pending[0].messageCount).toBe(1);
    });

    it('respects the cursor', () => {
      seedGroup(db, 'g1@g.us', { folder: 'g1' });
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:01Z', 'old');
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:05Z', 'new');
      advanceCursor(db, 'g1@g.us', '2026-04-18T00:00:02Z');
      const pending = getGroupsWithPending(db, 'Andy');
      expect(pending).toHaveLength(1);
      expect(pending[0].messageCount).toBe(1);
      expect(pending[0].latestTimestamp).toBe('2026-04-18T00:00:05Z');
    });

    it('excludes bot and empty messages', () => {
      seedGroup(db, 'g1@g.us', { folder: 'g1' });
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:01Z', 'Andy: hi', { isBot: true });
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:02Z', '');
      seedMessage(db, 'g1@g.us', '2026-04-18T00:00:03Z', 'real');
      const pending = getGroupsWithPending(db, 'Andy');
      expect(pending[0].messageCount).toBe(1);
    });
  });

  describe('getMessagesSince', () => {
    it('returns messages in chronological order and respects limit', () => {
      seedGroup(db, 'g1@g.us', { folder: 'g1' });
      for (let i = 1; i <= 5; i++) {
        seedMessage(db, 'g1@g.us', `2026-04-18T00:00:0${i}Z`, `msg${i}`);
      }
      const rows = getMessagesSince(db, 'g1@g.us', '', 'Andy', 3);
      expect(rows).toHaveLength(3);
      // Subquery picks the 3 most recent, outer orders ascending → msg3..msg5
      expect(rows[0].content).toBe('msg3');
      expect(rows[2].content).toBe('msg5');
    });
  });

  describe('advanceCursor', () => {
    it('updates only the given group, preserving others', () => {
      advanceCursor(db, 'g1@g.us', '2026-04-18T00:00:01Z');
      advanceCursor(db, 'g2@g.us', '2026-04-18T00:00:02Z');
      advanceCursor(db, 'g1@g.us', '2026-04-18T00:00:05Z');
      const row = db
        .prepare(`SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`)
        .get();
      const parsed = JSON.parse(row.value);
      expect(parsed['g1@g.us']).toBe('2026-04-18T00:00:05Z');
      expect(parsed['g2@g.us']).toBe('2026-04-18T00:00:02Z');
    });
  });

  describe('tick log', () => {
    it('starts and ends a tick with counts', () => {
      const id = startTick(db);
      endTick(db, id, { groupsProcessed: 3, messagesHandled: 7 });
      const row = db.prepare('SELECT * FROM tick_log WHERE id = ?').get(id);
      expect(row.status).toBe('ok');
      expect(row.groups_processed).toBe(3);
      expect(row.messages_handled).toBe(7);
      expect(row.ended_at).toBeTruthy();
    });

    it('marks ticks with errors', () => {
      const id = startTick(db);
      endTick(db, id, { error: 'daemon down' });
      const row = db.prepare('SELECT * FROM tick_log WHERE id = ?').get(id);
      expect(row.status).toBe('error');
      expect(row.error).toBe('daemon down');
    });
  });
});
