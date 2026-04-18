import { describe, it, expect, beforeEach } from 'vitest';
import { resolveJid, sendMessage } from './send.mjs';
import { getPendingOutbox } from './db.mjs';
import { makeTestDb, registerGroupFixture } from './test-helpers.mjs';

describe('resolveJid', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    registerGroupFixture(db, 'family@g.us', { folder: 'family' });
    registerGroupFixture(db, 'me@s.whatsapp.net', {
      folder: 'main',
      isMain: true,
      requiresTrigger: false,
    });
  });

  it('returns jid when passed a registered jid', () => {
    expect(resolveJid(db, { jid: 'family@g.us' })).toBe('family@g.us');
  });

  it('resolves folder → jid', () => {
    expect(resolveJid(db, { folder: 'main' })).toBe('me@s.whatsapp.net');
  });

  it('throws on unregistered jid', () => {
    expect(() => resolveJid(db, { jid: 'stranger@g.us' })).toThrow(/not registered/);
  });

  it('throws on unknown folder', () => {
    expect(() => resolveJid(db, { folder: 'nope' })).toThrow(/not registered/);
  });

  it('throws when neither jid nor folder given', () => {
    expect(() => resolveJid(db, {})).toThrow(/jid or --folder/);
  });
});

describe('sendMessage', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    registerGroupFixture(db, 'x@g.us', { folder: 'x' });
  });

  it('enqueues an outbox row and returns its id', () => {
    const res = sendMessage(db, { jid: 'x@g.us' }, 'hello');
    expect(res.jid).toBe('x@g.us');
    expect(typeof res.outboxId).toBeTruthy();
    const pending = getPendingOutbox(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('hello');
  });

  it('trims whitespace and rejects empty text', () => {
    expect(() => sendMessage(db, { jid: 'x@g.us' }, '   ')).toThrow(/empty/);
    expect(getPendingOutbox(db)).toHaveLength(0);
  });

  it('refuses to send to unregistered JIDs', () => {
    expect(() => sendMessage(db, { jid: 'bogus@g.us' }, 'hi')).toThrow(/not registered/);
  });
});
