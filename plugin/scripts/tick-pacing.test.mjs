import { describe, it, expect, beforeEach } from 'vitest';
import { finalizeTick, processGroup, idleHint, prepareTick } from './tick.mjs';
import { getPendingOutbox } from './db.mjs';
import {
  makeTestDb,
  registerGroupFixture,
  seedMessageFixture,
} from './test-helpers.mjs';
import { BURST_INTERVAL_SECONDS, IDLE_LADDER } from './pacing.mjs';

describe('finalizeTick returns pacing decision', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns BURST interval on activity', () => {
    const { tickId } = prepareTick(db);
    const res = finalizeTick(db, tickId, { groupsProcessed: 1, messagesHandled: 2 });
    expect(res.pacing.seconds).toBe(BURST_INTERVAL_SECONDS);
    expect(res.pacing.activity).toBe(true);
  });

  it('climbs idle ladder on back-to-back idle ticks', () => {
    const first = finalizeTick(db, prepareTick(db).tickId, {}).pacing;
    const second = finalizeTick(db, prepareTick(db).tickId, {}).pacing;
    expect(first.seconds).toBe(IDLE_LADDER[0]);
    expect(second.seconds).toBe(IDLE_LADDER[1]);
  });

  it('propagates error to pacing (still idle, counter increments)', () => {
    const res = finalizeTick(db, prepareTick(db).tickId, { error: 'boom' });
    expect(res.pacing.activity).toBe(false);
    expect(res.pacing.idleCount).toBe(1);
  });
});

describe('processGroup atomicity', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    registerGroupFixture(db, 'me@s.whatsapp.net', {
      folder: 'main',
      isMain: true,
      requiresTrigger: false,
    });
    seedMessageFixture(db, 'me@s.whatsapp.net', '2026-04-18T10:00:00Z', 'hi');
  });

  it('enqueues reply AND advances cursor in one call', () => {
    const res = processGroup(db, {
      jid: 'me@s.whatsapp.net',
      latestTimestamp: '2026-04-18T10:00:00Z',
      reply: 'hello back',
    });
    expect(res.ok).toBe(true);
    expect(res.advanced).toBe(true);
    expect(res.outboxId).toBeTruthy();

    // Next prepare sees nothing pending.
    const { groups } = prepareTick(db);
    expect(groups).toEqual([]);
    expect(getPendingOutbox(db)).toHaveLength(1);
  });

  it('strips internal tags in-flight', () => {
    processGroup(db, {
      jid: 'me@s.whatsapp.net',
      latestTimestamp: '2026-04-18T10:00:00Z',
      reply: 'hi <internal>scratch</internal> there',
    });
    expect(getPendingOutbox(db)[0].text).toBe('hi  there');
  });

  it('skips outbox when reply is empty after stripping', () => {
    const res = processGroup(db, {
      jid: 'me@s.whatsapp.net',
      latestTimestamp: '2026-04-18T10:00:00Z',
      reply: '<internal>only internal</internal>',
    });
    expect(res.ok).toBe(true);
    expect(res.outboxId).toBeNull();
    expect(getPendingOutbox(db)).toHaveLength(0);
    // Cursor still advanced — user's message was acknowledged.
    expect(prepareTick(db).groups).toEqual([]);
  });

  it('does NOT advance cursor on error — messages retry', () => {
    const res = processGroup(db, {
      jid: 'me@s.whatsapp.net',
      latestTimestamp: '2026-04-18T10:00:00Z',
      reply: 'ignored',
      error: 'agent timed out',
    });
    expect(res.ok).toBe(false);
    expect(res.advanced).toBe(false);
    // Still pending.
    const { groups } = prepareTick(db);
    expect(groups).toHaveLength(1);
    expect(getPendingOutbox(db)).toHaveLength(0);
  });
});

describe('idleHint', () => {
  it('returns pacing decision without persisting a tick', () => {
    const db = makeTestDb();
    const first = idleHint(db);
    expect(first.seconds).toBe(IDLE_LADDER[0]);
    // idleHint's decision *does* persist (it uses decideNextInterval).
    // That's a trade-off; tests verify it's stable on subsequent calls.
    const second = idleHint(db);
    expect(second.seconds).toBe(IDLE_LADDER[1]);
  });
});
