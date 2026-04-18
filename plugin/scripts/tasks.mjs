#!/usr/bin/env node
/**
 * Scheduled-task CLI — create / list / pause / resume / cancel / due.
 *
 * Backs the `manage-tasks` skill. Reuses the `scheduled_tasks` table.
 *
 * Validation rules (in sync with src/ipc.ts and the skill):
 *   - cron expressions must parse (via cron-parser)
 *   - intervals must be a positive integer of milliseconds >= 10_000
 *   - once timestamps must be ISO and between now and 1 year from now
 *
 * Authorization is enforced by callers (main vs per-group agent). The CLI
 * itself always scopes writes to the supplied group_folder.
 */
import { openDb } from './db.mjs';
import { CronExpressionParser } from 'cron-parser';
import crypto from 'node:crypto';

const MIN_INTERVAL_MS = 10_000;
const MAX_ONCE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function nextRunForCron(value, tz) {
  try {
    return CronExpressionParser.parse(value, { tz }).next().toISOString();
  } catch (e) {
    throw new Error(`invalid cron: ${e?.message || e}`);
  }
}

function nextRunForInterval(value, anchor) {
  const ms = Number.parseInt(value, 10);
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
    throw new Error(`interval must be >= ${MIN_INTERVAL_MS} ms`);
  }
  const baseline = anchor ? new Date(anchor).getTime() : Date.now();
  let next = baseline + ms;
  const now = Date.now();
  while (next <= now) next += ms;
  return new Date(next).toISOString();
}

function validateOnce(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('invalid ISO timestamp');
  const dt = d.getTime() - Date.now();
  if (dt < 0) throw new Error('timestamp is in the past');
  if (dt > MAX_ONCE_HORIZON_MS) throw new Error('timestamp is more than 1 year out');
  return d.toISOString();
}

export function computeNextRun(scheduleType, scheduleValue, tz = 'UTC', anchor = null) {
  if (scheduleType === 'cron') return nextRunForCron(scheduleValue, tz);
  if (scheduleType === 'interval') return nextRunForInterval(scheduleValue, anchor);
  if (scheduleType === 'once') return validateOnce(scheduleValue);
  throw new Error(`unknown schedule_type: ${scheduleType}`);
}

export function createTask(db, spec) {
  const {
    groupFolder,
    chatJid,
    prompt,
    script = null,
    scheduleType,
    scheduleValue,
    contextMode = 'isolated',
    tz = process.env.TZ || 'UTC',
    id = `task-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  } = spec;
  if (!groupFolder) throw new Error('groupFolder is required');
  if (!chatJid) throw new Error('chatJid is required');
  if (!prompt && !script) throw new Error('either prompt or script is required');
  if (!['cron', 'interval', 'once'].includes(scheduleType))
    throw new Error(`bad schedule_type: ${scheduleType}`);
  if (!['isolated', 'group'].includes(contextMode))
    throw new Error(`bad context_mode: ${contextMode}`);

  const nextRun = computeNextRun(scheduleType, scheduleValue, tz);

  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
        context_mode, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    groupFolder,
    chatJid,
    prompt || '',
    script,
    scheduleType,
    scheduleValue,
    contextMode,
    nextRun,
    new Date().toISOString(),
  );

  return { id, nextRun };
}

export function listTasks(db, groupFolder = null) {
  const sql = groupFolder
    ? `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status
       FROM scheduled_tasks WHERE group_folder = ? ORDER BY COALESCE(next_run, created_at)`
    : `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status
       FROM scheduled_tasks ORDER BY COALESCE(next_run, created_at)`;
  return groupFolder ? db.prepare(sql).all(groupFolder) : db.prepare(sql).all();
}

export function pauseTask(db, id, groupFolder = null) {
  return setStatus(db, id, 'paused', groupFolder);
}
export function resumeTask(db, id, groupFolder = null) {
  return setStatus(db, id, 'active', groupFolder);
}
export function cancelTask(db, id, groupFolder = null) {
  const row = db.prepare(`SELECT group_folder FROM scheduled_tasks WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'task not found' };
  if (groupFolder && row.group_folder !== groupFolder) {
    return { ok: false, error: 'task belongs to another group' };
  }
  db.prepare(`DELETE FROM task_run_logs WHERE task_id = ?`).run(id);
  db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
  return { ok: true };
}

function setStatus(db, id, status, groupFolder) {
  const row = db.prepare(`SELECT group_folder FROM scheduled_tasks WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'task not found' };
  if (groupFolder && row.group_folder !== groupFolder) {
    return { ok: false, error: 'task belongs to another group' };
  }
  db.prepare(`UPDATE scheduled_tasks SET status = ? WHERE id = ?`).run(status, id);
  return { ok: true, status };
}

export function getDueTasks(db) {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run`,
    )
    .all(new Date().toISOString());
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = openDb();

  try {
    switch (cmd) {
      case 'create': {
        const json = rest.length ? rest.join(' ') : await readStdin();
        const spec = JSON.parse(json);
        const result = createTask(db, spec);
        console.log(JSON.stringify({ ok: true, ...result }));
        break;
      }
      case 'list':
        console.log(JSON.stringify(listTasks(db, rest[0] || null), null, 2));
        break;
      case 'pause':
        console.log(JSON.stringify(pauseTask(db, rest[0], rest[1] || null)));
        break;
      case 'resume':
        console.log(JSON.stringify(resumeTask(db, rest[0], rest[1] || null)));
        break;
      case 'cancel':
        console.log(JSON.stringify(cancelTask(db, rest[0], rest[1] || null)));
        break;
      case 'due':
        console.log(JSON.stringify(getDueTasks(db), null, 2));
        break;
      default:
        fail('usage: tasks.mjs <create|list|pause|resume|cancel|due> [args]');
    }
  } catch (e) {
    fail(String(e?.message || e));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
