/**
 * Subprocess-level smoke test for tick.mjs.
 *
 * Verifies the CLI contract every command / hook depends on: valid JSON
 * on stdout, non-zero exit on bad args, finalize row visible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TICK = new URL('./tick.mjs', import.meta.url).pathname;
const DB_CLI = new URL('./db.mjs', import.meta.url).pathname;

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
      jid TEXT PRIMARY KEY, name TEXT, folder TEXT UNIQUE,
      trigger_pattern TEXT, added_at TEXT,
      requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0
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

describe('tick.mjs CLI', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tick-cli-'));
    fs.mkdirSync(path.join(tmpRoot, 'store'), { recursive: true });
    const db = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    coreSchema(db);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function run(...args) {
    return spawnSync(process.execPath, [TICK, ...args], {
      env: { ...process.env, NANOCLAW_PROJECT_ROOT: tmpRoot, ASSISTANT_NAME: 'Andy' },
      encoding: 'utf-8',
    });
  }

  it('prepare returns ok, tickId, and an empty groups array', () => {
    const res = run('prepare');
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.tickId).toBe('number');
    expect(parsed.groups).toEqual([]);
  });

  it('prepare returns a group with messagesXml when messages are pending', () => {
    const db = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
       VALUES ('me@s.whatsapp.net', 'me', 'main', '@Andy', ?, 0, 1)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES ('m1', 'me@s.whatsapp.net', 'user', 'User', 'hi there', '2026-04-18T10:00:00Z', 0, 0)`,
    ).run();
    db.close();

    const res = run('prepare');
    const parsed = JSON.parse(res.stdout);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].folder).toBe('main');
    expect(parsed.groups[0].messagesXml).toContain('hi there');
    expect(parsed.groups[0].latestTimestamp).toBe('2026-04-18T10:00:00Z');
  });

  it('advance + finalize + reply chain works end-to-end', () => {
    const db = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
       VALUES ('me@s.whatsapp.net', 'me', 'main', '@Andy', ?, 0, 1)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES ('m1', 'me@s.whatsapp.net', 'user', 'User', 'hi', '2026-04-18T10:00:00Z', 0, 0)`,
    ).run();
    db.close();

    const prep = JSON.parse(run('prepare').stdout);
    const { tickId, groups } = prep;
    expect(groups).toHaveLength(1);

    const replyRes = JSON.parse(
      run('reply', groups[0].jid, 'hello', 'there').stdout,
    );
    expect(replyRes.ok).toBe(true);
    expect(replyRes.enqueued).toBe(true);

    const advRes = JSON.parse(
      run('advance', groups[0].jid, groups[0].latestTimestamp).stdout,
    );
    expect(advRes.ok).toBe(true);

    const finRes = JSON.parse(run('finalize', String(tickId), '1', '1').stdout);
    expect(finRes.ok).toBe(true);

    // Next prepare should see nothing pending.
    const prep2 = JSON.parse(run('prepare').stdout);
    expect(prep2.groups).toEqual([]);

    // Outbox has the reply.
    const db2 = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    const outbox = db2.prepare('SELECT chat_jid, text, status FROM outbox').all();
    db2.close();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toBe('hello there');
    expect(outbox[0].status).toBe('pending');
  });

  it('unknown subcommand exits non-zero with ok=false JSON', () => {
    const res = run('nope');
    expect(res.status).not.toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
  });

  it('db.mjs status CLI returns valid JSON', () => {
    const res = spawnSync(process.execPath, [DB_CLI, 'status'], {
      env: { ...process.env, NANOCLAW_PROJECT_ROOT: tmpRoot },
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty('outbox');
    expect(parsed).toHaveProperty('groups');
    expect(parsed).toHaveProperty('daemons');
  });
});
