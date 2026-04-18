/**
 * Integration test that simulates one /claw-tick cycle end-to-end using only
 * the plugin scripts (no Claude Code runtime). Mocks the group-agent subagent
 * with a deterministic fake reply.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migratePluginSchema,
  enqueueOutbox,
  getPendingOutbox,
  getGroupsWithPending,
  getMessagesSince,
  advanceCursor,
  startTick,
  endTick,
} from './db.mjs';
import { formatMessages, stripInternalTags } from './format.mjs';

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

function seedInbound(db, chatJid, ts, content, opts = {}) {
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

/**
 * Runs the same sequence /claw-tick performs, with a stubbed agent.
 * Returns a summary like the real command does.
 */
function simulateTick(db, botName, agentStub, { timezone = 'UTC' } = {}) {
  const tickId = startTick(db);
  let groupsProcessed = 0;
  let messagesHandled = 0;
  let error = null;

  try {
    const pending = getGroupsWithPending(db, botName);
    for (const g of pending) {
      const msgs = getMessagesSince(db, g.jid, g.cursor, botName, 10);
      if (msgs.length === 0) continue;

      if (g.requiresTrigger && !g.isMain) {
        const triggerRe = new RegExp(
          `^${g.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i',
        );
        const hasTrigger = msgs.some((m) => triggerRe.test(m.content.trim()));
        if (!hasTrigger) continue;
      }

      const prompt = formatMessages(msgs, timezone);
      const reply = stripInternalTags(agentStub(g, prompt, msgs));
      if (reply) {
        enqueueOutbox(db, g.jid, reply);
      }
      advanceCursor(db, g.jid, msgs[msgs.length - 1].timestamp);
      groupsProcessed += 1;
      messagesHandled += msgs.length;
    }
  } catch (e) {
    error = String(e?.message || e);
  } finally {
    endTick(db, tickId, { groupsProcessed, messagesHandled, error });
  }
  return { tickId, groupsProcessed, messagesHandled, error };
}

describe('tick simulation', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  it('processes a main-group message and enqueues an outbox row', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedInbound(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'what is the weather?');
    const stub = (group, prompt) => {
      expect(prompt).toContain('what is the weather?');
      return 'Sunny, 22°C.';
    };
    const res = simulateTick(db, 'Andy', stub);
    expect(res.groupsProcessed).toBe(1);
    expect(res.messagesHandled).toBe(1);

    const outbox = getPendingOutbox(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].chat_jid).toBe('me@s.whatsapp.net');
    expect(outbox[0].text).toBe('Sunny, 22°C.');
  });

  it('advances cursor so next tick sees no pending', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedInbound(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'ping');
    simulateTick(db, 'Andy', () => 'pong');
    // After first tick, no pending.
    expect(getGroupsWithPending(db, 'Andy')).toHaveLength(0);
    // Second tick does nothing.
    const res = simulateTick(db, 'Andy', () => {
      throw new Error('should not invoke agent when nothing pending');
    });
    expect(res.groupsProcessed).toBe(0);
  });

  it('skips non-main groups without a trigger match', () => {
    registerGroup(db, 'fam@g.us', { folder: 'family', trigger: '@Andy' });
    seedInbound(db, 'fam@g.us', '2026-04-18T10:00:00Z', 'did you see the news?');
    const res = simulateTick(db, 'Andy', () => {
      throw new Error('should not call agent');
    });
    expect(res.groupsProcessed).toBe(0);
    // Cursor NOT advanced — so a future trigger will still see the accumulated message.
    const still = getGroupsWithPending(db, 'Andy');
    expect(still).toHaveLength(1);
    expect(still[0].messageCount).toBe(1);
  });

  it('processes non-main groups once a trigger arrives', () => {
    registerGroup(db, 'fam@g.us', { folder: 'family', trigger: '@Andy' });
    seedInbound(db, 'fam@g.us', '2026-04-18T10:00:00Z', 'background chat');
    seedInbound(db, 'fam@g.us', '2026-04-18T10:05:00Z', '@Andy what was that?');
    let captured;
    simulateTick(db, 'Andy', (g, prompt) => {
      captured = prompt;
      return 'it was nothing.';
    });
    // Both messages should be in the agent prompt — the accumulated one + the trigger.
    expect(captured).toContain('background chat');
    expect(captured).toContain('@Andy what was that?');
    expect(getPendingOutbox(db)).toHaveLength(1);
  });

  it('strips internal tags before writing to outbox', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedInbound(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'hi');
    simulateTick(db, 'Andy', () => 'hello <internal>not for user</internal> there');
    expect(getPendingOutbox(db)[0].text).toBe('hello  there');
  });

  it('does not enqueue outbox when the agent returns an empty string', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedInbound(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'hi');
    const res = simulateTick(db, 'Andy', () => '');
    expect(res.groupsProcessed).toBe(1);
    expect(getPendingOutbox(db)).toHaveLength(0);
  });

  it('marks the tick as error when the agent throws', () => {
    registerGroup(db, 'me@s.whatsapp.net', { folder: 'main', isMain: true, requiresTrigger: false });
    seedInbound(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'hi');
    const res = simulateTick(db, 'Andy', () => {
      throw new Error('agent exploded');
    });
    expect(res.error).toMatch(/agent exploded/);
    const row = db.prepare('SELECT status, error FROM tick_log WHERE id = ?').get(res.tickId);
    expect(row.status).toBe('error');
  });
});
