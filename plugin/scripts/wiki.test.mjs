import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as wiki from './wiki.mjs';

describe('wiki helpers', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-wiki-'));
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'test'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'store'), { recursive: true });
    process.env.NANOCLAW_PROJECT_ROOT = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.NANOCLAW_PROJECT_ROOT;
  });

  it('write → read round trip', () => {
    wiki.writePage('test', 'dog-food', '# Dog food\n\nThe user prefers Orijen.');
    expect(wiki.readPage('test', 'dog-food')).toContain('Orijen');
  });

  it('returns null for missing pages', () => {
    expect(wiki.readPage('test', 'does-not-exist')).toBeNull();
  });

  it('list excludes index.md and returns sorted page names', () => {
    wiki.writePage('test', 'zebra', '# Zebra');
    wiki.writePage('test', 'alpha', '# Alpha');
    expect(wiki.listPages('test')).toEqual(['alpha', 'zebra']);
  });

  it('rejects invalid page names', () => {
    expect(() => wiki.writePage('test', 'Has Spaces', 'x')).toThrow();
    expect(() => wiki.writePage('test', '../escape', 'x')).toThrow();
    expect(() => wiki.writePage('test', 'CamelCase', 'x')).toThrow();
  });

  it('rebuilds index with summaries', () => {
    wiki.writePage('test', 'topic', '# Topic\n\nThis is the summary line.');
    const idx = fs.readFileSync(
      path.join(tmpRoot, 'groups', 'test', 'wiki', 'index.md'),
      'utf-8',
    );
    expect(idx).toContain('[topic](topic.md)');
    expect(idx).toContain('summary');
  });

  it('search finds matches by name or content', () => {
    wiki.writePage('test', 'widgets', '# Widgets\n\nThe user loves blue widgets.');
    wiki.writePage('test', 'unrelated', '# Other\n\nNothing to do with dogs.');
    const hits = wiki.searchPages('test', 'blue widgets');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('widgets');
    expect(hits[0].snippet).toMatch(/blue widgets/);
  });
});
