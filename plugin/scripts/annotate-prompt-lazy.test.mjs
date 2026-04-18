import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldPoll } from './annotate-prompt.mjs';

describe('shouldPoll (lazy-load gate)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-annotate-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when store/messages.db missing', () => {
    expect(shouldPoll({ projectRoot: tmp })).toBe(false);
  });

  it('returns false when DB exists but is 0 bytes (fresh install)', () => {
    fs.mkdirSync(path.join(tmp, 'store'));
    fs.writeFileSync(path.join(tmp, 'store', 'messages.db'), '');
    expect(shouldPoll({ projectRoot: tmp })).toBe(false);
  });

  it('returns true when DB file has content', () => {
    fs.mkdirSync(path.join(tmp, 'store'));
    fs.writeFileSync(path.join(tmp, 'store', 'messages.db'), Buffer.alloc(1024));
    expect(shouldPoll({ projectRoot: tmp })).toBe(true);
  });

  it('returns false when projectRoot is missing entirely', () => {
    expect(shouldPoll({ projectRoot: '/nonexistent/path' })).toBe(false);
  });
});
