#!/usr/bin/env node
/**
 * /claw-send — enqueue an ad-hoc message to a registered group.
 *
 * Usage:
 *   send.mjs <jid> <text...>
 *   send.mjs --folder <folder> <text...>     (lookup jid by folder)
 *
 * Writes to the outbox; the channel daemon delivers. Refuses to send to
 * an unregistered JID (prevents typos and leaks).
 */
import { openDb, enqueueOutbox } from './db.mjs';

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { text: [], jid: null, folder: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--folder') out.folder = argv[++i];
    else if (a === '--jid') out.jid = argv[++i];
    else if (!out.jid && !out.folder && /^[-\w:@.]+$/.test(a) && (a.includes('@') || a.startsWith('slack:'))) {
      out.jid = a;
    } else {
      out.text.push(a);
    }
  }
  return out;
}

export function resolveJid(db, { jid, folder }) {
  if (jid) {
    const row = db
      .prepare(`SELECT jid FROM registered_groups WHERE jid = ?`)
      .get(jid);
    if (!row) throw new Error(`jid not registered: ${jid}`);
    return row.jid;
  }
  if (folder) {
    const row = db
      .prepare(`SELECT jid FROM registered_groups WHERE folder = ?`)
      .get(folder);
    if (!row) throw new Error(`folder not registered: ${folder}`);
    return row.jid;
  }
  throw new Error('need --jid or --folder');
}

export function sendMessage(db, target, text) {
  const jid = resolveJid(db, target);
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('message text is empty');
  const outboxId = enqueueOutbox(db, jid, trimmed);
  return { jid, outboxId };
}

async function cli() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.text.length === 0) fail('usage: send.mjs (<jid>|--folder <folder>) <text>');
  const db = openDb();
  try {
    const res = sendMessage(db, parsed, parsed.text.join(' '));
    console.log(JSON.stringify({ ok: true, ...res }));
  } catch (e) {
    fail(String(e?.message || e));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
