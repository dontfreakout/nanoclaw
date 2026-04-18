---
name: check-pending
description: List groups with unread inbound messages and/or undelivered outbox rows. Use when the user asks "what's pending?", when /claw-tick starts, or when the agent needs to decide whether to do work this iteration.
---

# Check pending

## Inbound pending messages

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" pending "${ASSISTANT_NAME:-Andy}"
```

Returns JSON:

```json
[
  {
    "jid": "120363...@g.us",
    "name": "Family",
    "folder": "family",
    "trigger": "@Andy",
    "requiresTrigger": true,
    "isMain": false,
    "messageCount": 3,
    "latestTimestamp": "2026-04-18T00:12:35Z",
    "cursor": "2026-04-18T00:05:02Z"
  }
]
```

Empty array means "no new messages since last cursor". Default `ASSISTANT_NAME` is `Andy`.

## Outbox pending

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" outbox-pending
```

## Whole-system status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" status
```

This is what `/claw-status` uses.

## Presenting to the user

Group the output by channel where possible. Show counts, not the message text (privacy).
