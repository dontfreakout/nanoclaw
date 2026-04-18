import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migratePluginSchema, getPendingOutbox } from './db.mjs';
import { prepareTick, finalizeTick, writeReply } from './tick.mjs';

function coreSchema(db) {
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
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT, chat_jid TEXT,
      prompt TEXT, script TEXT, schedule_type TEXT, schedule_value TEXT,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT, last_run TEXT, last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT
    );
  `);
}

function registerGroup(db, jid, opts) {
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    opts.folder,
    opts.folder,
    opts.trigger || '@Andy',
    new Date().toISOString(),
    opts.requiresTrigger === false ? 0 : 1,
    opts.isMain ? 1 : 0,
  );
}

function seedMsg(db, chatJid, ts, content, opts = {}) {
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id || `${chatJid}-${ts}-${Math.random()}`,
    chatJid,
    opts.sender || 'user',
    opts.senderName || 'User',
    content,
    ts,
    0,
    0,
  );
}

describe('prepareTick', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  it('returns a tickId and empty groups when nothing pending', () => {
    const { tickId, groups } = prepareTick(db);
    expect(tickId).toBeGreaterThan(0);
    expect(groups).toEqual([]);
  });

  it('includes main-group messages without requiring trigger', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedMsg(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'tell me a joke');
    const { groups } = prepareTick(db, { botName: 'Andy' });
    expect(groups).toHaveLength(1);
    expect(groups[0].folder).toBe('main');
    expect(groups[0].messagesXml).toContain('tell me a joke');
    expect(groups[0].latestTimestamp).toBe('2026-04-18T10:00:00Z');
  });

  it('skips triggered groups without a trigger in the batch', () => {
    registerGroup(db, 'fam@g.us', { folder: 'family', trigger: '@Andy' });
    seedMsg(db, 'fam@g.us', '2026-04-18T10:00:00Z', 'background chatter');
    const { groups } = prepareTick(db, { botName: 'Andy' });
    expect(groups).toHaveLength(0);
  });

  it('includes triggered groups once a trigger message arrives', () => {
    registerGroup(db, 'fam@g.us', { folder: 'family', trigger: '@Andy' });
    seedMsg(db, 'fam@g.us', '2026-04-18T10:00:00Z', 'context line');
    seedMsg(db, 'fam@g.us', '2026-04-18T10:05:00Z', '@Andy please reply');
    const { groups } = prepareTick(db, { botName: 'Andy' });
    expect(groups).toHaveLength(1);
    expect(groups[0].messageCount).toBe(2);
    expect(groups[0].messagesXml).toContain('context line');
    expect(groups[0].messagesXml).toContain('@Andy please reply');
  });

  it('returns messages in chronological order with the whole batch', () => {
    registerGroup(db, 'main@s.whatsapp.net', {
      folder: 'main',
      isMain: true,
      requiresTrigger: false,
    });
    for (let i = 0; i < 5; i++) {
      seedMsg(db, 'main@s.whatsapp.net', `2026-04-18T10:00:0${i}Z`, `msg${i}`);
    }
    const { groups } = prepareTick(db, { botName: 'Andy', limit: 10 });
    expect(groups[0].messageCount).toBe(5);
    expect(groups[0].messages[0].content).toBe('msg0');
    expect(groups[0].messages[4].content).toBe('msg4');
  });
});

describe('finalizeTick', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  it('writes groups_processed, messages_handled, status=ok', () => {
    const { tickId } = prepareTick(db);
    finalizeTick(db, tickId, { groupsProcessed: 2, messagesHandled: 5 });
    const row = db.prepare('SELECT * FROM tick_log WHERE id = ?').get(tickId);
    expect(row.status).toBe('ok');
    expect(row.groups_processed).toBe(2);
    expect(row.messages_handled).toBe(5);
  });

  it('writes status=error when error is non-null', () => {
    const { tickId } = prepareTick(db);
    finalizeTick(db, tickId, { error: 'agent timed out' });
    const row = db.prepare('SELECT * FROM tick_log WHERE id = ?').get(tickId);
    expect(row.status).toBe('error');
    expect(row.error).toBe('agent timed out');
  });
});

describe('writeReply', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  it('enqueues a stripped reply', () => {
    const res = writeReply(db, 'me@g.us', 'hello <internal>note</internal> there');
    expect(res.enqueued).toBe(true);
    const outbox = getPendingOutbox(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toBe('hello  there');
  });

  it('skips enqueue when stripped reply is empty', () => {
    const res = writeReply(db, 'me@g.us', '<internal>only internal</internal>');
    expect(res.enqueued).toBe(false);
    expect(getPendingOutbox(db)).toHaveLength(0);
  });
});
