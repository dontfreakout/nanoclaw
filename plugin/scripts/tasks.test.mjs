import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeNextRun,
  createTask,
  listTasks,
  pauseTask,
  resumeTask,
  cancelTask,
  getDueTasks,
} from './tasks.mjs';
import { migratePluginSchema } from './db.mjs';

function coreSchema(db) {
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
}

describe('computeNextRun', () => {
  it('parses valid cron', () => {
    const next = computeNextRun('cron', '0 * * * *', 'UTC');
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });
  it('rejects invalid cron', () => {
    expect(() => computeNextRun('cron', 'not a cron')).toThrow(/invalid cron/);
  });
  it('accepts interval >= 10s', () => {
    const next = computeNextRun('interval', '10000');
    const dt = new Date(next).getTime() - Date.now();
    expect(dt).toBeGreaterThan(9000);
    expect(dt).toBeLessThan(12000);
  });
  it('rejects intervals under 10s', () => {
    expect(() => computeNextRun('interval', '1000')).toThrow(/>= 10000/);
  });
  it('rejects non-numeric intervals', () => {
    expect(() => computeNextRun('interval', 'soon')).toThrow(/>= 10000/);
  });
  it('accepts a once ISO in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(computeNextRun('once', future)).toBe(new Date(future).toISOString());
  });
  it('rejects once in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(() => computeNextRun('once', past)).toThrow(/past/);
  });
  it('rejects once more than 1 year out', () => {
    const far = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
    expect(() => computeNextRun('once', far)).toThrow(/year/);
  });
  it('rejects unknown schedule type', () => {
    expect(() => computeNextRun('eventually', 'x')).toThrow(/unknown/);
  });
});

describe('task CRUD', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    coreSchema(db);
    migratePluginSchema(db);
  });

  it('creates and lists tasks scoped to group_folder', () => {
    createTask(db, {
      groupFolder: 'team',
      chatJid: 'team@g.us',
      prompt: 'standup',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * 1-5',
    });
    createTask(db, {
      groupFolder: 'home',
      chatJid: 'home@g.us',
      prompt: 'groceries',
      scheduleType: 'interval',
      scheduleValue: String(24 * 60 * 60 * 1000),
    });
    expect(listTasks(db)).toHaveLength(2);
    expect(listTasks(db, 'team')).toHaveLength(1);
    expect(listTasks(db, 'team')[0].prompt).toBe('standup');
  });

  it('pauses and resumes', () => {
    const { id } = createTask(db, {
      groupFolder: 'x',
      chatJid: 'x@g.us',
      prompt: 'p',
      scheduleType: 'interval',
      scheduleValue: '60000',
    });
    pauseTask(db, id);
    expect(listTasks(db)[0].status).toBe('paused');
    resumeTask(db, id);
    expect(listTasks(db)[0].status).toBe('active');
  });

  it('refuses to mutate a task from a different group', () => {
    const { id } = createTask(db, {
      groupFolder: 'team',
      chatJid: 'team@g.us',
      prompt: 'p',
      scheduleType: 'interval',
      scheduleValue: '60000',
    });
    const res = pauseTask(db, id, 'home');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/another group/);
  });

  it('cancel removes task and its run logs', () => {
    const { id } = createTask(db, {
      groupFolder: 'x',
      chatJid: 'x@g.us',
      prompt: 'p',
      scheduleType: 'interval',
      scheduleValue: '60000',
    });
    db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status)
       VALUES (?, ?, ?, 'ok')`,
    ).run(id, new Date().toISOString(), 100);
    const res = cancelTask(db, id);
    expect(res.ok).toBe(true);
    expect(listTasks(db)).toHaveLength(0);
    const logs = db.prepare('SELECT * FROM task_run_logs WHERE task_id = ?').all(id);
    expect(logs).toHaveLength(0);
  });

  it('getDueTasks returns only tasks past their next_run', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
       VALUES ('due', 'x', 'x@g.us', 'p', 'interval', '60000', ?, 'active', ?)`,
    ).run(past, new Date().toISOString());
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
       VALUES ('later', 'x', 'x@g.us', 'p', 'interval', '60000', ?, 'active', ?)`,
    ).run(future, new Date().toISOString());
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
       VALUES ('paused', 'x', 'x@g.us', 'p', 'interval', '60000', ?, 'paused', ?)`,
    ).run(past, new Date().toISOString());
    const due = getDueTasks(db);
    expect(due.map((t) => t.id)).toEqual(['due']);
  });

  it('rejects bad schedule_type on create', () => {
    expect(() =>
      createTask(db, {
        groupFolder: 'x',
        chatJid: 'x@g.us',
        prompt: 'p',
        scheduleType: 'eventually',
        scheduleValue: 'x',
      }),
    ).toThrow(/schedule_type/);
  });

  it('rejects bad context_mode on create', () => {
    expect(() =>
      createTask(db, {
        groupFolder: 'x',
        chatJid: 'x@g.us',
        prompt: 'p',
        scheduleType: 'interval',
        scheduleValue: '60000',
        contextMode: 'wrong',
      }),
    ).toThrow(/context_mode/);
  });

  it('requires groupFolder, chatJid, and either prompt or script', () => {
    expect(() =>
      createTask(db, { chatJid: 'x', scheduleType: 'interval', scheduleValue: '60000', prompt: 'x' }),
    ).toThrow(/groupFolder/);
    expect(() =>
      createTask(db, { groupFolder: 'x', scheduleType: 'interval', scheduleValue: '60000', prompt: 'x' }),
    ).toThrow(/chatJid/);
    expect(() =>
      createTask(db, {
        groupFolder: 'x',
        chatJid: 'x',
        scheduleType: 'interval',
        scheduleValue: '60000',
      }),
    ).toThrow(/prompt or script/);
  });
});
