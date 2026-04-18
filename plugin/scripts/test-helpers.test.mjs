import { describe, it, expect } from 'vitest';
import {
  makeTestDb,
  applyCoreSchema,
  registerGroupFixture,
  seedMessageFixture,
  CORE_SCHEMA_SQL,
} from './test-helpers.mjs';
import Database from 'better-sqlite3';

describe('makeTestDb', () => {
  it('creates both core and plugin tables', () => {
    const db = makeTestDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => r.name);
    for (const expected of [
      'chats',
      'daemon_state',
      'messages',
      'outbox',
      'registered_groups',
      'router_state',
      'scheduled_tasks',
      'sessions',
      'task_run_logs',
      'tick_log',
      'wiki_pages',
    ]) {
      expect(tables).toContain(expected);
    }
  });
});

describe('applyCoreSchema', () => {
  it('is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
    const db = new Database(':memory:');
    applyCoreSchema(db);
    expect(() => applyCoreSchema(db)).not.toThrow();
  });
});

describe('registerGroupFixture', () => {
  it('inserts a row with defaults', () => {
    const db = makeTestDb();
    registerGroupFixture(db, 'x@g.us', { folder: 'x' });
    const row = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('x@g.us');
    expect(row.folder).toBe('x');
    expect(row.trigger_pattern).toBe('@Andy');
    expect(row.requires_trigger).toBe(1);
    expect(row.is_main).toBe(0);
  });

  it('honors isMain and requiresTrigger:false', () => {
    const db = makeTestDb();
    registerGroupFixture(db, 'me@s.whatsapp.net', {
      folder: 'main',
      isMain: true,
      requiresTrigger: false,
    });
    const row = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('me@s.whatsapp.net');
    expect(row.is_main).toBe(1);
    expect(row.requires_trigger).toBe(0);
  });
});

describe('seedMessageFixture', () => {
  it('inserts a message with sensible defaults', () => {
    const db = makeTestDb();
    seedMessageFixture(db, 'x@g.us', '2026-04-18T00:00:00Z', 'hi');
    const row = db.prepare('SELECT * FROM messages').get();
    expect(row.content).toBe('hi');
    expect(row.is_from_me).toBe(0);
    expect(row.is_bot_message).toBe(0);
  });

  it('supports isBot and isFromMe flags', () => {
    const db = makeTestDb();
    seedMessageFixture(db, 'x@g.us', '2026-04-18T00:00:00Z', 'bot reply', { isBot: true });
    seedMessageFixture(db, 'x@g.us', '2026-04-18T00:00:01Z', 'I said', { isFromMe: true, id: 'me-1' });
    const rows = db.prepare('SELECT content, is_bot_message, is_from_me FROM messages ORDER BY timestamp').all();
    expect(rows[0].is_bot_message).toBe(1);
    expect(rows[1].is_from_me).toBe(1);
  });
});

describe('CORE_SCHEMA_SQL export', () => {
  it('is a non-empty string', () => {
    expect(typeof CORE_SCHEMA_SQL).toBe('string');
    expect(CORE_SCHEMA_SQL.length).toBeGreaterThan(100);
  });
});
