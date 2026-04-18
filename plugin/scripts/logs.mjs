#!/usr/bin/env node
/**
 * /claw-logs — tail/read daemon logs.
 *
 * Usage:
 *   logs.mjs                              → last 20 lines from every log
 *   logs.mjs whatsapp                     → last 20 lines from whatsapp.log
 *   logs.mjs whatsapp 100                 → last 100 lines from whatsapp.log
 *   logs.mjs whatsapp errors              → whatsapp.err.log (stderr)
 *   logs.mjs --list                       → list available log files
 */
import fs from 'node:fs';
import path from 'node:path';

const KNOWN = ['whatsapp', 'slack', 'outbox-worker'];

function logsDir() {
  const root = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
  return path.join(root, 'logs');
}

export function listLogs() {
  const dir = logsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort();
}

export function readTail(filename, lines = 20) {
  const file = path.join(logsDir(), filename);
  if (!fs.existsSync(file)) return { exists: false, lines: [] };
  const content = fs.readFileSync(file, 'utf-8');
  const all = content.split('\n').filter(Boolean);
  return {
    exists: true,
    totalLines: all.length,
    lines: all.slice(-lines),
  };
}

export function resolveLogName(daemon, stream) {
  if (!KNOWN.includes(daemon)) {
    throw new Error(`unknown daemon: ${daemon} (known: ${KNOWN.join(', ')})`);
  }
  return stream === 'errors' || stream === 'err'
    ? `${daemon}.err.log`
    : `${daemon}.log`;
}

function parseArgs(argv) {
  const opts = { daemon: null, stream: 'out', lines: 20, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list' || a === '-l') opts.list = true;
    else if (KNOWN.includes(a)) opts.daemon = a;
    else if (a === 'errors' || a === 'err') opts.stream = 'errors';
    else if (/^\d+$/.test(a)) opts.lines = Number(a);
  }
  return opts;
}

async function cli() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    console.log(JSON.stringify({ logs: listLogs() }, null, 2));
    return;
  }

  const daemons = opts.daemon ? [opts.daemon] : KNOWN;
  for (const d of daemons) {
    const filename = resolveLogName(d, opts.stream);
    const { exists, totalLines, lines } = readTail(filename, opts.lines);
    console.log(`\n===== ${filename} =====`);
    if (!exists) {
      console.log('(no log file yet)');
      continue;
    }
    console.log(`(${totalLines} total lines, showing last ${lines.length})`);
    console.log(lines.join('\n'));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
