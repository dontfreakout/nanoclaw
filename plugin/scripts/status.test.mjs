import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migratePluginSchema, enqueueOutbox, markOutboxDelivered, startTick, endTick } from './db.mjs';
import { formatStatus, humanAge, collectStatus } from './status.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT, folder TEXT,
      trigger_pattern TEXT, added_at TEXT,
      requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0
    );
  `);
  migratePluginSchema(db);
  return db;
}

describe('humanAge', () => {
  it.each([
    [0, '0s ago'],
    [1500, '1s ago'],
    [59_000, '59s ago'],
    [60_000, '1m ago'],
    [30 * 60_000, '30m ago'],
    [60 * 60_000, '1h ago'],
    [25 * 60 * 60_000, '25h ago'],
    [49 * 60 * 60_000, '2d ago'],
    [-1, '0s ago'],
  ])('%d ms → %s', (ms, expected) => {
    expect(humanAge(ms)).toBe(expected);
  });
});

describe('formatStatus', () => {
  it('shows zeros on a fresh install', () => {
    const out = formatStatus({
      outbox: { pending: 0, delivered: 0, failed: 0 },
      groups: 0,
      daemons: [],
      lastTick: null,
    });
    expect(out).toContain('Daemons: none');
    expect(out).toContain('Groups: 0');
    expect(out).toContain('0 pending');
    expect(out).toContain('Last tick: (none)');
  });

  it('formats running daemons with dots and PIDs', () => {
    const out = formatStatus({
      outbox: { pending: 0, delivered: 0, failed: 0 },
      groups: 1,
      daemons: [
        { name: 'whatsapp', pid: 1234, status: 'running' },
        { name: 'slack', pid: null, status: 'error' },
      ],
      lastTick: null,
    });
    expect(out).toMatch(/● whatsapp\(1234\)/);
    expect(out).toMatch(/○ slack/);
  });

  it('shows tick summary for ok ticks', () => {
    const endedAt = new Date(Date.now() - 45_000).toISOString();
    const out = formatStatus({
      outbox: { pending: 2, delivered: 10, failed: 0 },
      groups: 3,
      daemons: [],
      lastTick: {
        id: 42,
        ended_at: endedAt,
        status: 'ok',
        groups_processed: 2,
        messages_handled: 7,
      },
    });
    expect(out).toMatch(/Last tick: #42 · 45s ago · 2 groups · 7 msgs/);
  });

  it('shows error for failed ticks', () => {
    const out = formatStatus({
      outbox: { pending: 0, delivered: 0, failed: 0 },
      groups: 0,
      daemons: [],
      lastTick: {
        id: 99,
        ended_at: new Date().toISOString(),
        status: 'error',
        error: 'agent timed out',
      },
    });
    expect(out).toMatch(/Last tick: #99 · \d+s ago · error \(agent timed out\)/);
  });
});

describe('collectStatus', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  it('reflects outbox counts by status', () => {
    const id1 = enqueueOutbox(db, 'x@g.us', 'one');
    enqueueOutbox(db, 'x@g.us', 'two');
    markOutboxDelivered(db, id1);

    const status = collectStatus(db);
    expect(status.outbox.pending).toBe(1);
    expect(status.outbox.delivered).toBe(1);
    expect(status.outbox.failed).toBe(0);
  });

  it('reflects registered groups count', () => {
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
       VALUES ('a@g.us', 'a', 'a', '@Andy', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
       VALUES ('b@g.us', 'b', 'b', '@Andy', ?)`,
    ).run(new Date().toISOString());
    expect(collectStatus(db).groups).toBe(2);
  });

  it('returns null lastTick when there are no ticks', () => {
    expect(collectStatus(db).lastTick).toBeNull();
  });

  it('returns the most recent tick', () => {
    const id = startTick(db);
    endTick(db, id, { groupsProcessed: 1, messagesHandled: 2 });
    const status = collectStatus(db);
    expect(status.lastTick.id).toBe(id);
    expect(status.lastTick.groups_processed).toBe(1);
  });
});
