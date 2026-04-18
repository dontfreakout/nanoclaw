import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildDaemons,
  credentialsPresent,
  isAlive,
  readDaemonState,
  writeDaemonState,
} from './bootstrap.mjs';

describe('buildDaemons', () => {
  it('returns three daemons with required fields', () => {
    const daemons = buildDaemons();
    expect(daemons.map((d) => d.name)).toEqual(['whatsapp', 'slack', 'outbox-worker']);
    for (const d of daemons) {
      expect(typeof d.script).toBe('string');
      expect(typeof d.interpreter).toBe('string');
      expect(Array.isArray(d.envRequired)).toBe(true);
    }
  });

  it('Slack daemon requires both slack tokens', () => {
    const daemons = buildDaemons();
    const slack = daemons.find((d) => d.name === 'slack');
    expect(slack.envRequired).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN']);
  });
});

describe('credentialsPresent', () => {
  let tmpRoot;
  const saved = {};
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-creds-'));
    process.env.NANOCLAW_PROJECT_ROOT = tmpRoot;
    for (const k of ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'FOO']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.NANOCLAW_PROJECT_ROOT;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns true when required array is empty', () => {
    expect(credentialsPresent([])).toBe(true);
  });

  it('checks .env file if present', () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(credentialsPresent(['FOO'])).toBe(true);
    expect(credentialsPresent(['FOO', 'MISSING'])).toBe(false);
  });

  it('falls back to process.env when no .env', () => {
    process.env.FOO = 'x';
    expect(credentialsPresent(['FOO'])).toBe(true);
    delete process.env.FOO;
    expect(credentialsPresent(['FOO'])).toBe(false);
  });

  it('rejects empty values', () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'FOO=\n');
    expect(credentialsPresent(['FOO'])).toBe(false);
  });
});

describe('isAlive', () => {
  it('returns false for pid 0 / falsy', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
  });

  it('returns true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent pid', () => {
    expect(isAlive(0x7fff_ffff)).toBe(false);
  });
});

describe('readDaemonState / writeDaemonState', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dst-'));
    process.env.NANOCLAW_PROJECT_ROOT = tmpRoot;
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.NANOCLAW_PROJECT_ROOT;
  });

  it('round-trips state', () => {
    writeDaemonState({ whatsapp: { pid: 1234, port: 9101 } });
    expect(readDaemonState()).toEqual({
      whatsapp: { pid: 1234, port: 9101 },
    });
  });

  it('returns empty object when file is missing', () => {
    expect(readDaemonState()).toEqual({});
  });

  it('returns empty object when file is corrupt', () => {
    fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'data', 'daemons.json'), 'not json');
    expect(readDaemonState()).toEqual({});
  });
});
