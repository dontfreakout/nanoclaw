#!/usr/bin/env node
/**
 * Wiki helpers — read/write durable markdown notes per group.
 *
 * Pages live at `groups/<folder>/wiki/*.md` on disk (authoritative).
 * Optionally cached in `wiki_pages` sqlite table for fast search.
 *
 * CLI:
 *   wiki.mjs list <folder>
 *   wiki.mjs read <folder> <name>
 *   wiki.mjs write <folder> <name> < content-on-stdin
 *   wiki.mjs search <folder> <query>
 *   wiki.mjs index <folder>          (rebuild index.md from file listing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

function projectRoot() {
  return process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
}

function groupsDir() {
  return path.join(projectRoot(), 'groups');
}

function wikiDir(folder) {
  const dir = path.join(groupsDir(), folder, 'wiki');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pageName(name) {
  const clean = name.replace(/\.md$/i, '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) {
    throw new Error(`Invalid page name "${name}" — use kebab-case alphanumerics`);
  }
  return clean;
}

export function listPages(folder) {
  const dir = wikiDir(folder);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function readPage(folder, name) {
  const dir = wikiDir(folder);
  const file = path.join(dir, `${pageName(name)}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

export function writePage(folder, name, content) {
  const dir = wikiDir(folder);
  const clean = pageName(name);
  const file = path.join(dir, `${clean}.md`);
  fs.writeFileSync(file, content);

  const db = openDb();
  db.prepare(
    `INSERT OR REPLACE INTO wiki_pages (group_folder, name, content, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(folder, clean, content, new Date().toISOString());

  rebuildIndex(folder);
  return file;
}

export function searchPages(folder, query) {
  const dir = wikiDir(folder);
  const results = [];
  for (const name of listPages(folder)) {
    const content = fs.readFileSync(path.join(dir, `${name}.md`), 'utf-8');
    const lower = content.toLowerCase();
    const q = query.toLowerCase();
    if (name.toLowerCase().includes(q) || lower.includes(q)) {
      const idx = lower.indexOf(q);
      const snippet = content.slice(Math.max(0, idx - 40), idx + 120).replace(/\n/g, ' ');
      results.push({ name, snippet });
    }
  }
  return results;
}

export function rebuildIndex(folder) {
  const dir = wikiDir(folder);
  const pages = listPages(folder);
  const lines = [
    `# Wiki index — ${folder}`,
    '',
    pages.length === 0 ? '_No pages yet._' : '',
  ];
  for (const name of pages) {
    const content = fs.readFileSync(path.join(dir, `${name}.md`), 'utf-8');
    const firstLine = content
      .split('\n')
      .find((l) => l.trim() && !l.startsWith('#')) || '';
    const summary = firstLine.slice(0, 80);
    lines.push(`- [${name}](${name}.md)${summary ? ` — ${summary}` : ''}`);
  }
  fs.writeFileSync(path.join(dir, 'index.md'), lines.filter(Boolean).join('\n') + '\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
      console.log(JSON.stringify(listPages(rest[0]), null, 2));
      break;
    case 'read': {
      const content = readPage(rest[0], rest[1]);
      if (content === null) {
        console.error(`page not found: ${rest[1]}`);
        process.exit(2);
      }
      process.stdout.write(content);
      break;
    }
    case 'write': {
      const [folder, name] = rest;
      const content = await readStdin();
      const file = writePage(folder, name, content);
      console.log(file);
      break;
    }
    case 'search':
      console.log(JSON.stringify(searchPages(rest[0], rest.slice(1).join(' ')), null, 2));
      break;
    case 'index':
      rebuildIndex(rest[0]);
      console.log('ok');
      break;
    default:
      console.error('usage: wiki.mjs <list|read|write|search|index> <folder> [args]');
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
