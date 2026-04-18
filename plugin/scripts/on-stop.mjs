#!/usr/bin/env node
/**
 * Stop hook + /claw-stop entry.
 *
 * Sends SIGTERM to every daemon recorded in data/daemons.json and clears
 * their rows in daemon_state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const DAEMONS_FILE = path.join(PROJECT_ROOT, 'data', 'daemons.json');

function readDaemonState() {
  try {
    return JSON.parse(fs.readFileSync(DAEMONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const db = openDb();
  const state = readDaemonState();
  const report = {};

  for (const [name, info] of Object.entries(state)) {
    if (info?.pid && isAlive(info.pid)) {
      try {
        process.kill(info.pid, 'SIGTERM');
        report[name] = { stopped: true, pid: info.pid };
      } catch (e) {
        report[name] = { stopped: false, error: String(e.message || e) };
      }
    } else {
      report[name] = { stopped: false, reason: 'not-alive' };
    }
  }

  db.prepare(`UPDATE daemon_state SET status = 'stopped'`).run();

  // Leave file in place so claw-start can see what used to be running.
  fs.writeFileSync(
    DAEMONS_FILE,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(state).map(([k, v]) => [k, { ...v, stopped_at: new Date().toISOString() }]),
      ),
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, stopped: report }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
