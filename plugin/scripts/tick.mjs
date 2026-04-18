#!/usr/bin/env node
/**
 * /claw-tick orchestration — does everything a tick can do without calling Claude.
 *
 * Subcommands:
 *   prepare              → list groups needing a subagent call + tickId
 *   process-group        → reply + advance in one atomic call (takes JSON on argv or stdin)
 *   finalize             → close out the tick_log row, return pacing decision
 *   advance <jid> <ts>   → advance cursor (kept for compatibility)
 *   reply <jid> <text>   → enqueue a reply (kept for compatibility)
 *   due                  → list due scheduled tasks
 *   idle-hint            → return pacing decision as if this were an idle tick
 *                           (used by /loop to self-pace without running a tick)
 *
 * All output is single-line JSON. Designed so the /claw-tick command.md stays
 * minimal and context-cheap.
 */
import {
  openDb,
  startTick,
  endTick,
  getGroupsWithPending,
  getMessagesSince,
  advanceCursor,
  enqueueOutbox,
} from './db.mjs';
import { formatMessages, stripInternalTags } from './format.mjs';
import { messageTriggers } from './trigger.mjs';
import { getDueTasks } from './tasks.mjs';
import { decideNextInterval } from './pacing.mjs';

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

export function prepareTick(
  db,
  { botName = process.env.ASSISTANT_NAME || 'Andy', timezone = process.env.TZ || 'UTC', limit = 10 } = {},
) {
  const tickId = startTick(db);
  const pending = getGroupsWithPending(db, botName);
  const groups = [];

  for (const g of pending) {
    const msgs = getMessagesSince(db, g.jid, g.cursor, botName, limit);
    if (msgs.length === 0) continue;

    if (g.requiresTrigger && !g.isMain) {
      const hasTrigger = msgs.some((m) => messageTriggers(m.content, g.trigger, botName));
      if (!hasTrigger) continue;
    }

    groups.push({
      jid: g.jid,
      folder: g.folder,
      isMain: g.isMain,
      name: g.name,
      messages: msgs,
      messagesXml: formatMessages(msgs, timezone),
      latestTimestamp: msgs[msgs.length - 1].timestamp,
      messageCount: msgs.length,
    });
  }

  return { tickId, groups };
}

export function finalizeTick(db, tickId, { groupsProcessed = 0, messagesHandled = 0, error = null } = {}) {
  endTick(db, tickId, { groupsProcessed, messagesHandled, error });
  const pacing = decideNextInterval(db, { groupsProcessed, messagesHandled });
  return { pacing };
}

export function writeReply(db, jid, text) {
  const cleaned = stripInternalTags(String(text || ''));
  if (!cleaned) return { enqueued: false, reason: 'empty after stripping' };
  const id = enqueueOutbox(db, jid, cleaned);
  return { enqueued: true, outboxId: id };
}

/**
 * Atomic "I got a reply from the subagent for this group":
 *   - strips internal tags, enqueues reply (if any)
 *   - advances the cursor
 * One sqlite transaction → one process spawn per group, instead of 2.
 */
export function processGroup(db, { jid, latestTimestamp, reply, error = null }) {
  const txn = db.transaction((input) => {
    let outboxId = null;
    if (!input.error) {
      const cleaned = stripInternalTags(String(input.reply || ''));
      if (cleaned) outboxId = enqueueOutbox(db, input.jid, cleaned);
      // Advance cursor only on success.
      advanceCursor(db, input.jid, input.latestTimestamp);
      return { ok: true, jid: input.jid, outboxId, advanced: true };
    }
    // Agent error — skip cursor advance so messages retry next tick.
    return { ok: false, jid: input.jid, advanced: false, error: input.error };
  });
  return txn({ jid, latestTimestamp, reply, error });
}

/**
 * Look up pacing without running any work. Used by /loop when it wakes up
 * and wants to know whether to defer.
 */
export function idleHint(db, opts = {}) {
  // Don't persist a state bump — this is a peek, not a tick.
  const pacing = decideNextInterval(db, {}, opts);
  return pacing;
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
      case 'prepare': {
        const { tickId, groups } = prepareTick(db);
        console.log(JSON.stringify({ ok: true, tickId, groups }, null, 2));
        break;
      }
      case 'finalize': {
        const [id, groupsProcessed = '0', messagesHandled = '0', error = null] = rest;
        if (!id) fail('usage: tick.mjs finalize <tickId> <groups> <messages> [err]');
        const result = finalizeTick(db, Number(id), {
          groupsProcessed: Number(groupsProcessed),
          messagesHandled: Number(messagesHandled),
          error: error || null,
        });
        console.log(JSON.stringify({ ok: true, ...result }));
        break;
      }
      case 'process-group': {
        const json = rest.length ? rest.join(' ') : await readStdin();
        const input = JSON.parse(json);
        console.log(JSON.stringify(processGroup(db, input)));
        break;
      }
      case 'idle-hint': {
        console.log(JSON.stringify({ ok: true, pacing: idleHint(db) }));
        break;
      }
      case 'advance': {
        const [jid, ts] = rest;
        if (!jid || !ts) fail('usage: tick.mjs advance <jid> <timestamp>');
        advanceCursor(db, jid, ts);
        console.log(JSON.stringify({ ok: true }));
        break;
      }
      case 'reply': {
        const [jid, ...textParts] = rest;
        const text = textParts.join(' ');
        if (!jid) fail('usage: tick.mjs reply <jid> <text>');
        console.log(JSON.stringify({ ok: true, ...writeReply(db, jid, text) }));
        break;
      }
      case 'due': {
        console.log(JSON.stringify(getDueTasks(db), null, 2));
        break;
      }
      default:
        fail('usage: tick.mjs <prepare|finalize|advance|reply|due>');
    }
  } catch (e) {
    fail(String(e?.message || e));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
