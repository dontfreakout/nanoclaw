/**
 * Trigger-pattern helpers — port of src/config.ts#buildTriggerPattern etc.
 *
 * A message triggers a group when the trigger phrase appears at the start of
 * the message, followed by a word boundary. Matching is case-insensitive.
 */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger) {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export function getTriggerPattern(trigger, assistantName = 'Andy') {
  const normalized = typeof trigger === 'string' ? trigger.trim() : '';
  return buildTriggerPattern(normalized || `@${assistantName}`);
}

export function messageTriggers(message, trigger, assistantName = 'Andy') {
  const re = getTriggerPattern(trigger, assistantName);
  return re.test(String(message || '').trim());
}
