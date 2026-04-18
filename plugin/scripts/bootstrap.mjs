#!/usr/bin/env node
/**
 * SessionStart hook + /claw-start entry.
 *
 * Idempotent:
 *   · migrates plugin sqlite schema
 *   · spawns whatsapp + slack daemons if their credentials exist and they're
 *     not already alive (pid in data/daemons.json)
 *   · spawns the outbox-worker
 *
 * Writes a one-line JSON to stdout when run as a hook so Claude Code can see
 * whether NanoClaw is healthy.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// openDb is imported lazily inside main() so hook-less use of the exports
// (tests, `node -e` diagnostics) doesn't spin up sqlite.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function projectRoot() {
  return process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
}
function dataDir() {
  return path.join(projectRoot(), 'data');
}
function logsDir() {
  return path.join(projectRoot(), 'logs');
}
function daemonsFile() {
  return path.join(dataDir(), 'daemons.json');
}
function tsxBin() {
  return path.join(projectRoot(), 'node_modules', '.bin', 'tsx');
}

export function buildDaemons() {
  return [
    {
      name: 'whatsapp',
      script: path.join(__dirname, 'whatsapp-daemon.ts'),
      interpreter: tsxBin(),
      port: 9101,
      envRequired: [],
    },
    {
      name: 'slack',
      script: path.join(__dirname, 'slack-daemon.ts'),
      interpreter: tsxBin(),
      port: 9102,
      envRequired: ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'],
    },
    {
      name: 'outbox-worker',
      script: path.join(__dirname, 'outbox-worker.mjs'),
      interpreter: process.execPath,
      port: 0,
      envRequired: [],
    },
  ];
}

export function readDaemonState() {
  try {
    return JSON.parse(fs.readFileSync(daemonsFile(), 'utf-8'));
  } catch {
    return {};
  }
}

export function writeDaemonState(state) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(daemonsFile(), JSON.stringify(state, null, 2));
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function credentialsPresent(required) {
  if (required.length === 0) return true;
  try {
    const env = fs.readFileSync(path.join(projectRoot(), '.env'), 'utf-8');
    return required.every((k) => new RegExp(`^${k}=.+`, 'm').test(env));
  } catch {
    return required.every((k) => !!process.env[k]);
  }
}

function startDaemon(daemon) {
  fs.mkdirSync(logsDir(), { recursive: true });
  const out = fs.openSync(path.join(logsDir(), `${daemon.name}.log`), 'a');
  const err = fs.openSync(path.join(logsDir(), `${daemon.name}.err.log`), 'a');
  const interpreter = daemon.interpreter || process.execPath;
  if (!fs.existsSync(interpreter)) {
    throw new Error(
      `interpreter not found: ${interpreter} — run 'npm install' first`,
    );
  }
  const child = spawn(interpreter, [daemon.script], {
    cwd: projectRoot(),
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      NANOCLAW_PROJECT_ROOT: projectRoot(),
      DAEMON_PORT: String(daemon.port || 0),
    },
  });
  child.unref();
  return child.pid;
}

async function main() {
  const { openDb } = await import('./db.mjs');
  const db = openDb();
  const state = readDaemonState();
  const report = {};

  for (const daemon of buildDaemons()) {
    if (!credentialsPresent(daemon.envRequired)) {
      report[daemon.name] = { status: 'missing-credentials' };
      continue;
    }
    const existing = state[daemon.name];
    if (existing && isAlive(existing.pid)) {
      report[daemon.name] = { status: 'running', pid: existing.pid };
      continue;
    }
    try {
      const pid = startDaemon(daemon);
      state[daemon.name] = {
        pid,
        port: daemon.port,
        started_at: new Date().toISOString(),
      };
      report[daemon.name] = { status: 'started', pid };
      db.prepare(
        `INSERT OR REPLACE INTO daemon_state (name, pid, port, status, started_at, error)
         VALUES (?, ?, ?, 'running', ?, NULL)`,
      ).run(daemon.name, pid, daemon.port, new Date().toISOString());
    } catch (e) {
      report[daemon.name] = { status: 'error', error: String(e.message || e) };
      db.prepare(
        `INSERT OR REPLACE INTO daemon_state (name, pid, port, status, started_at, error)
         VALUES (?, NULL, ?, 'error', NULL, ?)`,
      ).run(daemon.name, daemon.port, String(e.message || e));
    }
  }

  writeDaemonState(state);
  console.log(JSON.stringify({ ok: true, daemons: report }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  });
}
