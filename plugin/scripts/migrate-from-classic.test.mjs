import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectLaunchd,
  detectSystemd,
  detectRunningProcess,
  detectDb,
  migrate,
} from './migrate-from-classic.mjs';

describe('detect helpers', () => {
  it('detectLaunchd returns null on non-darwin platforms', () => {
    // We don't mock os.platform — on Linux runs it must be null.
    if (process.platform !== 'darwin') {
      expect(detectLaunchd()).toBeNull();
    }
  });

  it('detectSystemd returns null on non-linux platforms', () => {
    if (process.platform !== 'linux') {
      expect(detectSystemd()).toBeNull();
    }
  });

  it('detectRunningProcess returns an array (possibly empty)', () => {
    const result = detectRunningProcess();
    expect(Array.isArray(result)).toBe(true);
  });

  it('detectDb reports absent when file missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-migrate-'));
    try {
      expect(detectDb(tmp)).toEqual({ present: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detectDb reports size when file present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-migrate-'));
    try {
      fs.mkdirSync(path.join(tmp, 'store'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'store', 'messages.db'), 'fake');
      const res = detectDb(tmp);
      expect(res.present).toBe(true);
      expect(res.sizeBytes).toBe(4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('migrate (dry-run)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-migrate-full-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('produces a report with nextSteps even on a fresh install', () => {
    const report = migrate({ projectRoot: tmp, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.db.present).toBe(false);
    expect(Array.isArray(report.nextSteps)).toBe(true);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.nextSteps.join('\n')).toMatch(/claw-start/);
  });

  it('does not run plugin schema migration in dry-run', () => {
    fs.mkdirSync(path.join(tmp, 'store'), { recursive: true });
    // Intentionally write a non-sqlite file — in dry-run we should not try to open it.
    fs.writeFileSync(path.join(tmp, 'store', 'messages.db'), 'bogus');
    const report = migrate({ projectRoot: tmp, dryRun: true });
    expect(report.pluginSchemaMigrated).toBe(false);
    expect(report.pluginSchemaMigratedError).toBeUndefined();
  });

  it('surfaces running manual processes in nextSteps when present', () => {
    // Can't easily spawn a matching process here; just verify the field shape.
    const report = migrate({ projectRoot: tmp, dryRun: true });
    expect(Array.isArray(report.running)).toBe(true);
  });
});
