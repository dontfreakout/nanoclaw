import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migratePluginSchema } from './db.mjs';
import { prune, dryRunPrune } from './prune.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT, chat_jid TEXT,
      prompt TEXT, script TEXT, schedule_type TEXT, schedule_value TEXT,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT, last_run TEXT, last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, run_at TEXT,
      duration_ms INTEGER, status TEXT, result TEXT, error TEXT
    );
  `);
  migratePluginSchema(db);
  return db;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('prune', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  it('deletes delivered outbox rows older than the cutoff', () => {
    // Old delivered
    db.prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at, delivered_at)
       VALUES ('a', 'old delivered', 'delivered', ?, ?)`,
    ).run(daysAgo(60), daysAgo(60));
    // New delivered
    db.prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at, delivered_at)
       VALUES ('a', 'new delivered', 'delivered', ?, ?)`,
    ).run(daysAgo(1), daysAgo(1));
    // Old pending (must NOT be deleted)
    db.prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at)
       VALUES ('a', 'old pending', 'pending', ?)`,
    ).run(daysAgo(60));
    // Old failed (should be deleted)
    db.prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at)
       VALUES ('a', 'old failed', 'failed', ?)`,
    ).run(daysAgo(60));

    const report = prune(db, { outboxDays: 30 });
    expect(report.outbox).toBe(2);
    const remaining = db.prepare(`SELECT text FROM outbox ORDER BY id`).all().map((r) => r.text);
    expect(remaining).toEqual(['new delivered', 'old pending']);
  });

  it('deletes tick_log rows older than cutoff but keeps running ticks', () => {
    db.prepare(
      `INSERT INTO tick_log (started_at, ended_at, status)
       VALUES (?, ?, 'ok')`,
    ).run(daysAgo(30), daysAgo(30));
    db.prepare(
      `INSERT INTO tick_log (started_at, ended_at, status)
       VALUES (?, ?, 'ok')`,
    ).run(daysAgo(2), daysAgo(2));
    db.prepare(
      `INSERT INTO tick_log (started_at, status) VALUES (?, 'running')`,
    ).run(daysAgo(30));

    const report = prune(db, { tickDays: 14 });
    expect(report.tick_log).toBe(1);
    const rows = db.prepare(`SELECT status FROM tick_log`).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toContain('running');
  });

  it('deletes task_run_logs older than cutoff', () => {
    db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status) VALUES ('t1', ?, 100, 'ok')`,
    ).run(daysAgo(45));
    db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status) VALUES ('t1', ?, 100, 'ok')`,
    ).run(daysAgo(5));

    const report = prune(db, { taskLogDays: 30 });
    expect(report.task_run_logs).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM task_run_logs`).get().c).toBe(1);
  });

  it('never deletes scheduled_tasks rows', () => {
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
       VALUES ('t1', 'x', 'x@g.us', 'p', 'cron', '0 * * * *', ?, 'active', ?)`,
    ).run(daysAgo(60), daysAgo(60));
    prune(db, { outboxDays: 30, tickDays: 14, taskLogDays: 30 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM scheduled_tasks`).get().c).toBe(1);
  });
});

describe('dryRunPrune', () => {
  it('returns counts without deleting', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO outbox (chat_jid, text, status, created_at, delivered_at)
       VALUES ('a', 'old', 'delivered', ?, ?)`,
    ).run(daysAgo(60), daysAgo(60));
    const counts = dryRunPrune(db, { outboxDays: 30 });
    expect(counts.outbox).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM outbox`).get().c).toBe(1);
  });
});
