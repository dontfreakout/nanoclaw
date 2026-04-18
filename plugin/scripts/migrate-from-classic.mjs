#!/usr/bin/env node
/**
 * Migrate a classic NanoClaw install (Node.js service spawning container
 * agents) to the Claude Code plugin.
 *
 * This script never destroys data. It inspects the environment, stops the
 * long-running service if present, and prints the next manual steps.
 *
 * Detects (best-effort):
 *   - macOS launchd agent at ~/Library/LaunchAgents/com.nanoclaw.plist
 *   - Linux systemd user unit at ~/.config/systemd/user/nanoclaw.service
 *   - A running `nanoclaw` / `tsx src/index.ts` process (for manual starts)
 *
 * Safe to run on a fresh install: it'll just report "no classic install".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { openDb } from './db.mjs';

const HOME = os.homedir();
const PLATFORM = process.platform;

export function detectLaunchd() {
  if (PLATFORM !== 'darwin') return null;
  const plist = path.join(HOME, 'Library', 'LaunchAgents', 'com.nanoclaw.plist');
  return fs.existsSync(plist) ? plist : null;
}

export function detectSystemd() {
  if (PLATFORM !== 'linux') return null;
  const candidates = [
    path.join(HOME, '.config', 'systemd', 'user', 'nanoclaw.service'),
    '/etc/systemd/system/nanoclaw.service',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function detectRunningProcess() {
  try {
    const out = execSync('ps -Ao pid,command 2>/dev/null', { encoding: 'utf-8' });
    const lines = out
      .split('\n')
      .slice(1)
      .filter((l) => /(?:node|tsx).*(?:nanoclaw|src\/index\.ts)/.test(l))
      .filter((l) => !/plugin\/scripts|outbox-worker|daemon/.test(l));
    return lines.map((l) => {
      const trimmed = l.trim();
      const space = trimmed.indexOf(' ');
      return {
        pid: Number.parseInt(trimmed.slice(0, space), 10),
        command: trimmed.slice(space + 1),
      };
    });
  } catch {
    return [];
  }
}

export function detectDb(projectRoot) {
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return { present: false };
  const stat = fs.statSync(dbPath);
  return { present: true, path: dbPath, sizeBytes: stat.size };
}

function stopLaunchd(plist, { dryRun = false } = {}) {
  if (dryRun) return { stopped: false, reason: 'dry-run' };
  const res = spawnSync('launchctl', ['unload', plist], { encoding: 'utf-8' });
  return {
    stopped: res.status === 0,
    status: res.status,
    stderr: res.stderr?.trim() || null,
  };
}

function stopSystemd({ dryRun = false } = {}) {
  if (dryRun) return { stopped: false, reason: 'dry-run' };
  const res = spawnSync('systemctl', ['--user', 'stop', 'nanoclaw'], {
    encoding: 'utf-8',
  });
  return {
    stopped: res.status === 0,
    status: res.status,
    stderr: res.stderr?.trim() || null,
  };
}

export function migrate({ projectRoot = process.cwd(), dryRun = false } = {}) {
  const report = {
    dryRun,
    platform: PLATFORM,
    launchd: null,
    systemd: null,
    running: [],
    db: detectDb(projectRoot),
    pluginSchemaMigrated: false,
    nextSteps: [],
  };

  const plist = detectLaunchd();
  if (plist) {
    report.launchd = { found: plist, ...stopLaunchd(plist, { dryRun }) };
  }
  const unit = detectSystemd();
  if (unit) {
    report.systemd = { found: unit, ...stopSystemd({ dryRun }) };
  }
  report.running = detectRunningProcess();

  if (report.db.present && !dryRun) {
    try {
      openDb(report.db.path);
      report.pluginSchemaMigrated = true;
    } catch (e) {
      report.pluginSchemaMigratedError = String(e?.message || e);
    }
  }

  report.nextSteps.push(
    report.launchd || report.systemd
      ? 'Classic service stopped. Keep the DB — the plugin uses it as-is.'
      : 'No classic service detected; proceeding as fresh install.',
  );
  if (report.running.length > 0) {
    report.nextSteps.push(
      `Manual nanoclaw processes still running (${report.running.length}). Kill them before starting the plugin: ` +
        report.running.map((p) => `kill ${p.pid}`).join('; '),
    );
  }
  report.nextSteps.push(
    'Run `/claw-start` in Claude Code (or `node plugin/scripts/bootstrap.mjs`) to boot the daemons.',
    'Run `/claw-status` to verify WhatsApp and Slack are connected.',
  );

  return report;
}

async function cli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const report = migrate({ projectRoot: process.cwd(), dryRun });
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
