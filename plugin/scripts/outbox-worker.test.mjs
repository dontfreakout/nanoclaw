import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migratePluginSchema, enqueueOutbox } from './db.mjs';
import { daemonFor, handleRow, tick } from './outbox-worker.mjs';

function makeDb() {
  const db = new Database(':memory:');
  migratePluginSchema(db);
  return db;
}

describe('daemonFor', () => {
  it.each([
    ['120@g.us', 'whatsapp'],
    ['me@s.whatsapp.net', 'whatsapp'],
    ['slack:C123', 'slack'],
    ['tg:42', 'telegram'],
    ['dc:42', 'discord'],
    ['unknown', null],
    [null, null],
    [42, null],
  ])('%s → %s', (jid, expected) => {
    expect(daemonFor(jid)).toBe(expected);
  });
});

describe('handleRow', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  it('marks unknown JIDs as failed', () => {
    const id = enqueueOutbox(db, 'bogus', 'hi');
    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    expect(handleRow(db, row, { isAlive: () => false })).toBe('no-daemon-mapping');
    const after = db.prepare('SELECT status, error FROM outbox WHERE id = ?').get(id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/no daemon/);
  });

  it('defers to live daemon', () => {
    const id = enqueueOutbox(db, 'me@g.us', 'hi');
    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    expect(handleRow(db, row, { isAlive: () => true })).toBe('daemon-owns-it');
    const after = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
  });

  it('bumps attempts when the matching daemon is down', () => {
    const id = enqueueOutbox(db, 'me@g.us', 'hi');
    let row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    expect(handleRow(db, row, { isAlive: () => false })).toBe('bumped-attempts');
    const after = db.prepare('SELECT status, attempts, error FROM outbox WHERE id = ?').get(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.error).toMatch(/whatsapp daemon down/);
  });

  it('fails after 10 attempts', () => {
    const id = enqueueOutbox(db, 'me@g.us', 'hi');
    // Simulate 10 previous bumps.
    db.prepare(`UPDATE outbox SET attempts = 10 WHERE id = ?`).run(id);
    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    expect(handleRow(db, row, { isAlive: () => false })).toBe('failed-after-retries');
    const after = db.prepare('SELECT status, error FROM outbox WHERE id = ?').get(id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/after 10 retries/);
  });
});

describe('tick', () => {
  it('processes up to 50 pending rows per call and returns the count', async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) enqueueOutbox(db, 'slack:C1', `msg-${i}`);
    const processed = await tick(db, { isAlive: () => false });
    expect(processed).toBe(5);
    const attempts = db
      .prepare(`SELECT attempts FROM outbox ORDER BY id`)
      .all()
      .map((r) => r.attempts);
    expect(attempts).toEqual([1, 1, 1, 1, 1]);
  });
});
