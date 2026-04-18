---
name: send-message
description: Enqueue a message to be delivered to a chat via its channel (WhatsApp / Slack). The outbox worker picks it up asynchronously. Use when the agent wants to send a message that is NOT a reply to the current tick (proactive notifications, scheduled-task results, cross-group messages from the main group).
---

# Send message

Normal replies go through `/claw-tick` writing to the outbox itself. Use this skill only for **out-of-band** sends: alerts, notifications, multi-message replies, or cross-group messages (main group only).

## How

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" outbox-enqueue "<chatJid>" "<text>"
```

The returned id is the outbox row id.

## Authorization

- A per-group agent may only enqueue messages to its OWN `chat_jid`.
- The main group's agent may enqueue to any registered group.
- Never enqueue to a JID not present in `registered_groups`.

## Delivery guarantees

- At-least-once. The outbox worker retries up to 5 times with exponential backoff.
- Ordering per-chat is preserved as long as the worker is single-threaded (it is).
- If delivery still fails after 5 attempts, the row moves to `failed` and is surfaced in `/claw-status`.
