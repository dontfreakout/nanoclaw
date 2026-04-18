/**
 * Adaptive pacing — decides how long /loop should wait before the next /claw-tick.
 *
 * Goal: cut token usage when idle, stay responsive during activity.
 *
 * Logic:
 *   - Activity tick (groupsProcessed > 0 or messagesHandled > 0) → reset to BURST.
 *   - Idle tick → bump to next step of the EXPONENTIAL_STEPS ladder.
 *   - Explicit override (router_state key `pacing_override` = { min, max, frozenUntil }) wins.
 *
 * State is stored in router_state as JSON under key `pacing_state`:
 *   { idleCount, lastDecision, lastChangedAt }
 *
 * Intentionally stateless module — exported helpers take a db handle + options
 * so tests don't need real time.
 */

// Cache is 5-minute TTL. Pick intervals that either stay well inside it (fast)
// or commit to a much longer wait (cheap). Never 300s — that's the worst of both.
export const BURST_INTERVAL_SECONDS = 30;
export const ACTIVE_INTERVAL_SECONDS = 60;
export const IDLE_LADDER = [120, 270, 900, 1800]; // 2m, 4.5m, 15m, 30m

const STATE_KEY = 'pacing_state';
const OVERRIDE_KEY = 'pacing_override';

export function loadPacingState(db) {
  const row = db.prepare(`SELECT value FROM router_state WHERE key = ?`).get(STATE_KEY);
  if (!row) return { idleCount: 0, lastDecision: null, lastChangedAt: null };
  try {
    return JSON.parse(row.value);
  } catch {
    return { idleCount: 0, lastDecision: null, lastChangedAt: null };
  }
}

export function savePacingState(db, state) {
  db.prepare(
    `INSERT INTO router_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(STATE_KEY, JSON.stringify(state));
}

export function loadOverride(db) {
  const row = db.prepare(`SELECT value FROM router_state WHERE key = ?`).get(OVERRIDE_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setOverride(db, { min = null, max = null, untilIso = null } = {}) {
  if (min === null && max === null && untilIso === null) {
    db.prepare(`DELETE FROM router_state WHERE key = ?`).run(OVERRIDE_KEY);
    return { cleared: true };
  }
  const payload = { min, max, untilIso };
  db.prepare(
    `INSERT INTO router_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(OVERRIDE_KEY, JSON.stringify(payload));
  return { cleared: false, ...payload };
}

/**
 * Given the outcome of the tick we just ran, decide the next interval (seconds).
 * Also updates and persists pacing_state.
 */
export function decideNextInterval(db, tickOutcome, { now = Date.now() } = {}) {
  const state = loadPacingState(db);
  const override = loadOverride(db);

  // Clear expired override.
  if (override?.untilIso && new Date(override.untilIso).getTime() < now) {
    db.prepare(`DELETE FROM router_state WHERE key = ?`).run(OVERRIDE_KEY);
  }
  const active = override && (!override.untilIso || new Date(override.untilIso).getTime() >= now)
    ? override
    : null;

  const activity = (tickOutcome?.groupsProcessed || 0) > 0 || (tickOutcome?.messagesHandled || 0) > 0;
  let seconds;
  if (activity) {
    state.idleCount = 0;
    seconds = BURST_INTERVAL_SECONDS;
  } else {
    state.idleCount = (state.idleCount || 0) + 1;
    const idx = Math.min(state.idleCount - 1, IDLE_LADDER.length - 1);
    seconds = idx < 0 ? ACTIVE_INTERVAL_SECONDS : IDLE_LADDER[idx];
  }

  // Apply explicit override clamps.
  if (active) {
    if (typeof active.min === 'number') seconds = Math.max(seconds, active.min);
    if (typeof active.max === 'number') seconds = Math.min(seconds, active.max);
  }

  state.lastDecision = seconds;
  state.lastChangedAt = new Date(now).toISOString();
  savePacingState(db, state);

  return {
    seconds,
    activity,
    idleCount: state.idleCount,
    override: active,
  };
}

/**
 * Used by /claw-slow to pick a sensible default when the user doesn't pass
 * specific numbers — "slow down a bit" means 10 minutes min, "way down"
 * means 30.
 */
export function presetToOverride(preset) {
  switch (preset) {
    case 'burst':
      return { min: BURST_INTERVAL_SECONDS, max: ACTIVE_INTERVAL_SECONDS };
    case 'normal':
      return null;
    case 'slow':
      return { min: 600, max: 1800 };
    case 'away':
      return { min: 1800, max: 3600 };
    case 'clear':
    case null:
      return null;
    default:
      return null;
  }
}
