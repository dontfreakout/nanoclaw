#!/usr/bin/env node
/**
 * register-group CLI used by the /register-group command.
 *
 * Usage:
 *   register-group.mjs <jid> <folder> [trigger] [--main]
 *
 * Exits 0 on success with JSON { ok, folder, path } on stdout.
 * Exits non-zero with { ok: false, error } on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';
import { rebuildIndex } from './wiki.mjs';

const VALID_FOLDER = /^[a-zA-Z0-9_-]+$/;

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  let isMain = false;
  for (const a of argv) {
    if (a === '--main') isMain = true;
    else positional.push(a);
  }
  const [jid, folder, trigger] = positional;
  return { jid, folder, trigger, isMain };
}

async function main() {
  const { jid, folder, trigger, isMain } = parseArgs(process.argv.slice(2));
  if (!jid || !folder) {
    fail('usage: register-group.mjs <jid> <folder> [trigger] [--main]');
  }
  if (!VALID_FOLDER.test(folder)) {
    fail(`invalid folder name "${folder}" — must match ${VALID_FOLDER}`);
  }
  if (folder === 'global') {
    fail('folder name "global" is reserved');
  }

  const projectRoot = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
  const groupDir = path.join(projectRoot, 'groups', folder);
  const logsDir = path.join(groupDir, 'logs');
  const wikiDir = path.join(groupDir, 'wiki');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });

  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    const templateCandidates = [
      path.join(projectRoot, 'groups', isMain ? 'main' : 'global', 'CLAUDE.md'),
      path.join(projectRoot, 'groups', 'global', 'CLAUDE.md'),
    ];
    const template = templateCandidates.find((p) => fs.existsSync(p));
    if (template) {
      fs.copyFileSync(template, claudeMd);
    } else {
      fs.writeFileSync(
        claudeMd,
        `# ${folder}\n\nYou are the NanoClaw assistant for the "${folder}" group.\n`,
      );
    }
  }

  rebuildIndex(folder);

  const db = openDb();
  const triggerPattern =
    trigger || `@${process.env.ASSISTANT_NAME || 'Andy'}`;

  db.prepare(
    `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    folder,
    folder,
    triggerPattern,
    new Date().toISOString(),
    isMain ? 0 : 1,
    isMain ? 1 : 0,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        folder,
        path: groupDir,
        trigger: triggerPattern,
        isMain,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => fail(String(e?.message || e)));
