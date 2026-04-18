import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatLocalTime,
} from './format.mjs';

describe('escapeXml', () => {
  it('escapes the five special characters', () => {
    expect(escapeXml('<a href="&">x</a>')).toBe(
      '&lt;a href=&quot;&amp;&quot;&gt;x&lt;/a&gt;',
    );
  });
  it('returns empty string for empty input', () => {
    expect(escapeXml('')).toBe('');
  });
});

describe('stripInternalTags', () => {
  it('removes internal blocks', () => {
    expect(stripInternalTags('hi <internal>thinking</internal> there')).toBe(
      'hi  there',
    );
  });
  it('handles multiple blocks across lines', () => {
    expect(
      stripInternalTags('a <internal>one\ntwo</internal> b <internal>c</internal> d'),
    ).toBe('a  b  d');
  });
});

describe('formatMessages', () => {
  it('emits XML with timezone header and message lines', () => {
    const out = formatMessages(
      [
        {
          sender_name: 'Alice',
          content: 'hello',
          timestamp: '2026-04-18T12:00:00Z',
        },
      ],
      'UTC',
    );
    expect(out).toContain('<context timezone="UTC" />');
    expect(out).toMatch(/<message sender="Alice" time="[^"]+">hello<\/message>/);
  });

  it('includes reply_to attribute and quoted_message snippet', () => {
    const out = formatMessages(
      [
        {
          sender_name: 'Bob',
          content: 'ok',
          timestamp: '2026-04-18T12:00:01Z',
          reply_to_message_id: 'msg-123',
          reply_to_message_content: 'are you in?',
          reply_to_sender_name: 'Alice',
        },
      ],
      'UTC',
    );
    expect(out).toContain('reply_to="msg-123"');
    expect(out).toContain('<quoted_message from="Alice">are you in?</quoted_message>');
  });

  it('escapes dangerous content', () => {
    const out = formatMessages(
      [
        {
          sender_name: 'x<script>',
          content: 'a & b',
          timestamp: '2026-04-18T00:00:00Z',
        },
      ],
      'UTC',
    );
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('a &amp; b');
  });
});

describe('formatLocalTime', () => {
  it('returns a formatted string for valid input', () => {
    const result = formatLocalTime('2026-04-18T12:00:00Z', 'UTC');
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
  it('returns the input on parse errors', () => {
    expect(formatLocalTime('not-a-date', 'UTC')).toBe('not-a-date');
  });
});
