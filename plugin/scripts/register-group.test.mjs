import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('./register-group.mjs', import.meta.url).pathname;

function coreSchemaFile(projectRoot) {
  // register-group.mjs calls openDb() which runs the plugin migrations but
  // the registered_groups table comes from the core schema. We pre-create it
  // via a SQL file to sidestep booting src/db.ts in Node.
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const init = `
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY, name TEXT, folder TEXT UNIQUE,
      trigger_pattern TEXT, added_at TEXT,
      requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS router_state (key TEXT PRIMARY KEY, value TEXT);
  `;
  // Use better-sqlite3 programmatically to seed the schema.
  return init;
}

describe('register-group.mjs', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-reg-'));
    fs.mkdirSync(path.join(tmpRoot, 'store'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'global', 'CLAUDE.md'),
      '# Template\n\nYou are the assistant.\n',
    );
    // Seed core schema before register-group's openDb() runs plugin migrations.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    db.exec(coreSchemaFile(tmpRoot));
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NANOCLAW_PROJECT_ROOT: tmpRoot, ASSISTANT_NAME: 'Andy' },
      encoding: 'utf-8',
    });
  }

  it('creates folder, wiki, CLAUDE.md, and DB row', async () => {
    const res = run('120363@g.us', 'family', '@Andy');
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.folder).toBe('family');
    expect(out.trigger).toBe('@Andy');
    expect(out.isMain).toBe(false);

    expect(fs.existsSync(path.join(tmpRoot, 'groups', 'family', 'CLAUDE.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpRoot, 'groups', 'family', 'wiki', 'index.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'groups', 'family', 'logs'))).toBe(true);

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tmpRoot, 'store', 'messages.db'));
    const row = db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get('120363@g.us');
    db.close();
    expect(row).toBeTruthy();
    expect(row.folder).toBe('family');
    expect(row.trigger_pattern).toBe('@Andy');
    expect(row.is_main).toBe(0);
    expect(row.requires_trigger).toBe(1);
  });

  it('honors --main flag: no trigger required, is_main=1', () => {
    const res = run('me@s.whatsapp.net', 'main', '--main');
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.isMain).toBe(true);
  });

  it('rejects invalid folder names', () => {
    const res = run('jid@g.us', 'bad folder');
    expect(res.status).not.toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/invalid folder/i);
  });

  it('rejects the reserved "global" folder', () => {
    const res = run('jid@g.us', 'global');
    expect(res.status).not.toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.error).toMatch(/reserved/i);
  });

  it('defaults trigger to @<ASSISTANT_NAME>', () => {
    const res = run('jid@g.us', 'team');
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.trigger).toBe('@Andy');
  });
});
