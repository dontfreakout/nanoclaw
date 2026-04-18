#!/usr/bin/env node
/**
 * Prune old rows so the sqlite DB doesn't grow without bound.
 *
 * Deletes:
 *   - outbox rows where status in ('delivered', 'failed') and older than
 *     `--outbox-days` (default 30)
 *   - tick_log rows older than `--tick-days` (default 14)
 *   - task_run_logs rows older than `--task-log-days` (default 30)
 *
 * Never touches: messages, chats, registered_groups, scheduled_tasks (active),
 * wiki_pages, router_state, daemon_state.
 *
 * Returns a JSON report of rows deleted per table.
 */
import { openDb } from './db.mjs';

const DEFAULTS = {
  outboxDays: 30,
  tickDays: 14,
  taskLogDays: 30,
};

function cutoff(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export function prune(db, opts = {}) {
  const {
    outboxDays = DEFAULTS.outboxDays,
    tickDays = DEFAULTS.tickDays,
    taskLogDays = DEFAULTS.taskLogDays,
    now = Date.now(),
  } = opts;

  const outboxCutoff = cutoff(outboxDays, now);
  const tickCutoff = cutoff(tickDays, now);
  const taskLogCutoff = cutoff(taskLogDays, now);

  const report = {};

  // Outbox: only delivered or failed rows; never pending.
  const outboxRes = db
    .prepare(
      `DELETE FROM outbox
       WHERE status IN ('delivered', 'failed')
         AND COALESCE(delivered_at, created_at) < ?`,
    )
    .run(outboxCutoff);
  report.outbox = outboxRes.changes;

  // tick_log: completed ticks only.
  const tickRes = db
    .prepare(
      `DELETE FROM tick_log
       WHERE ended_at IS NOT NULL AND ended_at < ?`,
    )
    .run(tickCutoff);
  report.tick_log = tickRes.changes;

  // task_run_logs: all rows older than cutoff; parent task rows untouched.
  const taskLogRes = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(taskLogCutoff);
  report.task_run_logs = taskLogRes.changes;

  return report;
}

export function dryRunPrune(db, opts = {}) {
  const {
    outboxDays = DEFAULTS.outboxDays,
    tickDays = DEFAULTS.tickDays,
    taskLogDays = DEFAULTS.taskLogDays,
    now = Date.now(),
  } = opts;

  return {
    outbox: db
      .prepare(
        `SELECT COUNT(*) AS c FROM outbox
         WHERE status IN ('delivered', 'failed')
           AND COALESCE(delivered_at, created_at) < ?`,
      )
      .get(cutoff(outboxDays, now)).c,
    tick_log: db
      .prepare(
        `SELECT COUNT(*) AS c FROM tick_log
         WHERE ended_at IS NOT NULL AND ended_at < ?`,
      )
      .get(cutoff(tickDays, now)).c,
    task_run_logs: db
      .prepare(`SELECT COUNT(*) AS c FROM task_run_logs WHERE run_at < ?`)
      .get(cutoff(taskLogDays, now)).c,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--outbox-days') opts.outboxDays = Number(argv[++i]);
    else if (a === '--tick-days') opts.tickDays = Number(argv[++i]);
    else if (a === '--task-log-days') opts.taskLogDays = Number(argv[++i]);
  }
  return opts;
}

async function cli() {
  const opts = parseArgs(process.argv.slice(2));
  const db = openDb();
  const report = opts.dryRun ? dryRunPrune(db, opts) : prune(db, opts);
  console.log(JSON.stringify({ ok: true, dryRun: !!opts.dryRun, deleted: report }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
