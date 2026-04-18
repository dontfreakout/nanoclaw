#!/usr/bin/env node
/**
 * Outbox worker: long-lived process that picks pending outbox rows NOT owned
 * by any specific daemon and attempts delivery via whichever daemon matches
 * the chat_jid shape.
 *
 * Most outbox rows are handled directly by the WhatsApp/Slack daemons (each
 * polls its own JID suffix). This worker is the catch-all for:
 *   - rows whose matching daemon is not alive (it retries briefly)
 *   - rows whose JID doesn't match any known daemon (marks them failed)
 *
 * Keeps the outbox from stalling if a daemon crashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

const MAX_RETRIES_WHEN_DAEMON_DOWN = 10;

function daemonsFile() {
  const root = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
  return path.join(root, 'data', 'daemons.json');
}

export function daemonFor(chatJid) {
  if (typeof chatJid !== 'string') return null;
  if (chatJid.endsWith('@g.us') || chatJid.endsWith('@s.whatsapp.net')) return 'whatsapp';
  if (chatJid.startsWith('slack:')) return 'slack';
  if (chatJid.startsWith('tg:')) return 'telegram';
  if (chatJid.startsWith('dc:')) return 'discord';
  return null;
}

export function daemonAlive(name) {
  try {
    const state = JSON.parse(fs.readFileSync(daemonsFile(), 'utf-8'));
    const pid = state[name]?.pid;
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process a single outbox row. Mutates the DB and returns a string describing
 * what happened (so tests can assert without reading the DB back).
 */
export function handleRow(db, row, { isAlive = daemonAlive } = {}) {
  const daemon = daemonFor(row.chat_jid);
  if (!daemon) {
    db.prepare(
      `UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`,
    ).run('no daemon matches chat_jid shape', row.id);
    return 'no-daemon-mapping';
  }
  if (isAlive(daemon)) return 'daemon-owns-it';

  const attempts = row.attempts ?? 0;
  if (attempts >= MAX_RETRIES_WHEN_DAEMON_DOWN) {
    db.prepare(
      `UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`,
    ).run(`${daemon} daemon down after ${attempts} retries`, row.id);
    return 'failed-after-retries';
  }
  db.prepare(
    `UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?`,
  ).run(`${daemon} daemon down`, row.id);
  return 'bumped-attempts';
}

export async function tick(db, opts = {}) {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, attempts FROM outbox
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT 50`,
    )
    .all();
  for (const row of rows) handleRow(db, row, opts);
  return rows.length;
}

async function main() {
  const db = openDb();
  setInterval(() => {
    tick(db).catch((e) => console.error('outbox-worker tick error', e));
  }, 5000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('outbox-worker crashed', e);
    process.exit(1);
  });
}
