import { describe, it, expect } from 'vitest';
import { buildAnnotation, annotatePrompt } from './annotate-prompt.mjs';

describe('buildAnnotation', () => {
  it('returns empty string when there is no pending work', () => {
    expect(buildAnnotation([])).toBe('');
    expect(buildAnnotation(null)).toBe('');
    expect(buildAnnotation(undefined)).toBe('');
  });

  it('returns empty string when message counts are all zero', () => {
    expect(buildAnnotation([{ messageCount: 0 }])).toBe('');
  });

  it('pluralizes one message / one group correctly', () => {
    const out = buildAnnotation([{ messageCount: 1 }]);
    expect(out).toContain('1 inbound message');
    expect(out).toContain('1 group');
    expect(out).not.toContain('messages');
    expect(out).not.toContain('groups');
  });

  it('pluralizes many correctly', () => {
    const out = buildAnnotation([
      { messageCount: 3 },
      { messageCount: 2 },
    ]);
    expect(out).toContain('5 inbound messages');
    expect(out).toContain('2 groups');
  });

  it('wraps the annotation in a <nanoclaw-status> tag', () => {
    const out = buildAnnotation([{ messageCount: 2 }]);
    expect(out).toMatch(/^\n\n<nanoclaw-status>/);
    expect(out).toMatch(/<\/nanoclaw-status>$/);
  });
});

describe('annotatePrompt', () => {
  it('appends annotation when pending > 0', () => {
    const input = JSON.stringify({ prompt: 'hello' });
    const out = annotatePrompt(input, {
      pendingProvider: () => [{ messageCount: 2 }],
    });
    const parsed = JSON.parse(out);
    expect(parsed.prompt).toMatch(/hello\n\n<nanoclaw-status>/);
  });

  it('is a no-op when nothing pending', () => {
    const input = JSON.stringify({ prompt: 'hello' });
    const out = annotatePrompt(input, { pendingProvider: () => [] });
    expect(JSON.parse(out).prompt).toBe('hello');
  });

  it('returns input unchanged when JSON is malformed', () => {
    const input = 'not json';
    expect(annotatePrompt(input)).toBe(input);
  });

  it('preserves sibling fields', () => {
    const input = JSON.stringify({ prompt: 'hi', sessionId: 'abc', hook: 'UserPromptSubmit' });
    const out = annotatePrompt(input, { pendingProvider: () => [{ messageCount: 1 }] });
    const parsed = JSON.parse(out);
    expect(parsed.sessionId).toBe('abc');
    expect(parsed.hook).toBe('UserPromptSubmit');
  });

  it('skips when payload has no prompt string', () => {
    const input = JSON.stringify({ sessionId: 'abc' });
    const out = annotatePrompt(input, { pendingProvider: () => [{ messageCount: 1 }] });
    expect(JSON.parse(out)).toEqual({ sessionId: 'abc' });
  });
});
