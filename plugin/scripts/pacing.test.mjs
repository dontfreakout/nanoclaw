import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './test-helpers.mjs';
import {
  BURST_INTERVAL_SECONDS,
  IDLE_LADDER,
  decideNextInterval,
  loadPacingState,
  loadOverride,
  setOverride,
  presetToOverride,
} from './pacing.mjs';

describe('decideNextInterval', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
  });

  it('resets to BURST on activity', () => {
    // Seed some idle history.
    decideNextInterval(db, { groupsProcessed: 0, messagesHandled: 0 });
    decideNextInterval(db, { groupsProcessed: 0, messagesHandled: 0 });
    expect(loadPacingState(db).idleCount).toBe(2);

    const res = decideNextInterval(db, { groupsProcessed: 1, messagesHandled: 3 });
    expect(res.seconds).toBe(BURST_INTERVAL_SECONDS);
    expect(res.activity).toBe(true);
    expect(loadPacingState(db).idleCount).toBe(0);
  });

  it('climbs the idle ladder on consecutive idle ticks', () => {
    const picked = [];
    for (let i = 0; i < IDLE_LADDER.length + 2; i++) {
      picked.push(decideNextInterval(db, {}).seconds);
    }
    expect(picked[0]).toBe(IDLE_LADDER[0]);
    expect(picked[1]).toBe(IDLE_LADDER[1]);
    expect(picked[IDLE_LADDER.length - 1]).toBe(IDLE_LADDER[IDLE_LADDER.length - 1]);
    // Further idle ticks stay at the ceiling.
    expect(picked.at(-1)).toBe(IDLE_LADDER.at(-1));
  });

  it('records a decision timestamp', () => {
    decideNextInterval(db, {});
    const state = loadPacingState(db);
    expect(state.lastDecision).toBe(IDLE_LADDER[0]);
    expect(typeof state.lastChangedAt).toBe('string');
  });
});

describe('overrides', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
  });

  it('setOverride and loadOverride round-trip', () => {
    setOverride(db, { min: 60, max: 600 });
    expect(loadOverride(db)).toEqual({ min: 60, max: 600, untilIso: null });
  });

  it('setOverride({}) clears the override', () => {
    setOverride(db, { min: 60, max: 600 });
    setOverride(db, {});
    expect(loadOverride(db)).toBeNull();
  });

  it('applies min clamp to boost a short interval', () => {
    setOverride(db, { min: 900 });
    const res = decideNextInterval(db, { groupsProcessed: 1 });
    expect(res.seconds).toBe(900);
  });

  it('applies max clamp to shrink a long interval', () => {
    setOverride(db, { max: 90 });
    // idle ladder starts at 120, clamp to 90.
    const res = decideNextInterval(db, {});
    expect(res.seconds).toBe(90);
  });

  it('auto-expires once untilIso passes', () => {
    setOverride(db, { min: 1800, untilIso: new Date(Date.now() - 1000).toISOString() });
    const res = decideNextInterval(db, {});
    expect(res.seconds).toBe(IDLE_LADDER[0]);
    expect(loadOverride(db)).toBeNull();
  });
});

describe('presetToOverride', () => {
  it.each([
    ['burst', { min: 30, max: 60 }],
    ['slow', { min: 600, max: 1800 }],
    ['away', { min: 1800, max: 3600 }],
    ['normal', null],
    ['clear', null],
    ['unknown-preset', null],
  ])('%s → %o', (preset, expected) => {
    expect(presetToOverride(preset)).toEqual(expected);
  });
});
