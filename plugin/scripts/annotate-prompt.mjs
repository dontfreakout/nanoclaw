#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * Reads the current pending-message count and, if > 0, appends a tiny
 * annotation to the prompt so the user (and the agent) know there's
 * inbound work without having to run /claw-status.
 *
 * Hooks read the prompt JSON from stdin and may write a modified JSON to
 * stdout. We append one line.
 */
// Intentionally NOT statically importing db.mjs — loading better-sqlite3 on
// every prompt is wasteful. We dynamic-import only when the cheap pre-check
// suggests there might be something to annotate.
import fs from 'node:fs';
import path from 'node:path';

export function buildAnnotation(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return '';
  const totals = pending.reduce((sum, g) => sum + (g.messageCount || 0), 0);
  if (totals === 0) return '';
  const msgWord = totals === 1 ? 'message' : 'messages';
  const groupWord = pending.length === 1 ? 'group' : 'groups';
  return (
    `\n\n<nanoclaw-status>${totals} inbound ${msgWord} across ${pending.length} ` +
    `${groupWord} — run /claw-tick or let /loop handle it.</nanoclaw-status>`
  );
}

export function annotatePrompt(input, { pendingProvider } = {}) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return input;
  }
  if (typeof data.prompt !== 'string') return JSON.stringify(data);

  const pending = typeof pendingProvider === 'function' ? pendingProvider() : [];
  const suffix = buildAnnotation(pending);
  if (suffix) data.prompt += suffix;
  return JSON.stringify(data);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Pre-check: is there even a DB to read from? Avoid loading better-sqlite3
 * on fresh installs, test runs, or sessions outside the nanoclaw repo.
 */
export function shouldPoll({ projectRoot = process.env.NANOCLAW_PROJECT_ROOT || process.cwd() } = {}) {
  try {
    const dbPath = path.join(projectRoot, 'store', 'messages.db');
    const stat = fs.statSync(dbPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const input = await readStdin();
  let output = input;

  if (!shouldPoll()) {
    process.stdout.write(output);
    return;
  }

  try {
    // Lazy-load — first prompt after a fresh install pays this cost once,
    // subsequent prompts reuse the Node module cache.
    const { openDb, getGroupsWithPending } = await import('./db.mjs');
    const db = openDb();
    const botName = process.env.ASSISTANT_NAME || 'Andy';
    output = annotatePrompt(input, {
      pendingProvider: () => {
        try {
          return getGroupsWithPending(db, botName);
        } catch {
          return [];
        }
      },
    });
  } catch {
    // Non-fatal — annotation is a nicety.
  }
  process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
