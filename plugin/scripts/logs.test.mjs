import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listLogs, readTail, resolveLogName } from './logs.mjs';

describe('resolveLogName', () => {
  it('returns <daemon>.log by default', () => {
    expect(resolveLogName('whatsapp')).toBe('whatsapp.log');
    expect(resolveLogName('slack', 'out')).toBe('slack.log');
  });

  it('returns <daemon>.err.log for errors stream', () => {
    expect(resolveLogName('whatsapp', 'errors')).toBe('whatsapp.err.log');
    expect(resolveLogName('slack', 'err')).toBe('slack.err.log');
  });

  it('rejects unknown daemons', () => {
    expect(() => resolveLogName('nope')).toThrow(/unknown daemon/);
  });
});

describe('listLogs + readTail', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-logs-'));
    process.env.NANOCLAW_PROJECT_ROOT = tmp;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.NANOCLAW_PROJECT_ROOT;
  });

  it('listLogs returns empty array when logs dir missing', () => {
    expect(listLogs()).toEqual([]);
  });

  it('listLogs returns .log files sorted', () => {
    fs.mkdirSync(path.join(tmp, 'logs'));
    fs.writeFileSync(path.join(tmp, 'logs', 'slack.log'), '');
    fs.writeFileSync(path.join(tmp, 'logs', 'whatsapp.log'), '');
    fs.writeFileSync(path.join(tmp, 'logs', 'noise.txt'), '');
    expect(listLogs()).toEqual(['slack.log', 'whatsapp.log']);
  });

  it('readTail says exists=false for missing files', () => {
    const res = readTail('nope.log', 10);
    expect(res).toEqual({ exists: false, lines: [] });
  });

  it('readTail returns the last N lines', () => {
    fs.mkdirSync(path.join(tmp, 'logs'));
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmp, 'logs', 'whatsapp.log'), content);
    const res = readTail('whatsapp.log', 5);
    expect(res.exists).toBe(true);
    expect(res.totalLines).toBe(50);
    expect(res.lines).toEqual([
      'line 46',
      'line 47',
      'line 48',
      'line 49',
      'line 50',
    ]);
  });

  it('readTail handles empty files', () => {
    fs.mkdirSync(path.join(tmp, 'logs'));
    fs.writeFileSync(path.join(tmp, 'logs', 'empty.log'), '');
    const res = readTail('empty.log', 10);
    expect(res.exists).toBe(true);
    expect(res.totalLines).toBe(0);
    expect(res.lines).toEqual([]);
  });
});
