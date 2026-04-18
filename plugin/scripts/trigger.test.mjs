import { describe, it, expect } from 'vitest';
import {
  buildTriggerPattern,
  getTriggerPattern,
  messageTriggers,
} from './trigger.mjs';

describe('buildTriggerPattern', () => {
  it('matches the trigger at the start of a message with a word boundary', () => {
    const re = buildTriggerPattern('@Andy');
    expect(re.test('@Andy hello')).toBe(true);
    expect(re.test('@Andy, what time is it?')).toBe(true);
    expect(re.test('@Andy.')).toBe(true);
  });

  it('is case-insensitive', () => {
    const re = buildTriggerPattern('@Andy');
    expect(re.test('@andy hi')).toBe(true);
    expect(re.test('@ANDY hi')).toBe(true);
  });

  it('does not match when trigger is in the middle', () => {
    const re = buildTriggerPattern('@Andy');
    expect(re.test('hey @Andy')).toBe(false);
  });

  it('requires a word boundary (no substring match)', () => {
    const re = buildTriggerPattern('@And');
    expect(re.test('@Andrew')).toBe(false);
    expect(re.test('@And something')).toBe(true);
  });

  it('escapes regex metacharacters in the trigger', () => {
    // Word-boundary anchor requires a word char; include a letter so \b fires.
    const re = buildTriggerPattern('#weather.bot');
    expect(re.test('#weather.bot today?')).toBe(true);
    expect(re.test('weatherbot today')).toBe(false);
  });
});

describe('getTriggerPattern fallback', () => {
  it('defaults to @<assistantName> when trigger is empty', () => {
    const re = getTriggerPattern(undefined, 'Rocky');
    expect(re.test('@Rocky hi')).toBe(true);
    expect(re.test('@Andy hi')).toBe(false);
  });

  it('trims whitespace', () => {
    const re = getTriggerPattern('   @Andy   ');
    expect(re.test('@Andy hi')).toBe(true);
  });
});

describe('messageTriggers', () => {
  it('trims leading whitespace on the message', () => {
    expect(messageTriggers('   @Andy hi', '@Andy')).toBe(true);
  });
  it('handles null/undefined messages', () => {
    expect(messageTriggers(null, '@Andy')).toBe(false);
    expect(messageTriggers(undefined, '@Andy')).toBe(false);
  });
});
