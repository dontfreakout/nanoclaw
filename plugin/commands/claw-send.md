---
name: claw-send
description: Enqueue an ad-hoc message to a registered group. Writes to the outbox; the WhatsApp/Slack daemon delivers. Use for proactive notifications, announcements, or to test delivery without involving the assistant's reasoning loop.
argument-hint: (<jid>|--folder <folder>) <text>
allowed-tools: Bash
---

Send a message to a registered group without involving the assistant.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" $ARGUMENTS
```

Examples:

- `/claw-send --folder main Good morning!`
- `/claw-send 1203635551234@g.us Heads up: scheduled maintenance in 10 min.`
- `/claw-send slack:C01ABCDEF The build is green.`

The script refuses to send to unregistered JIDs — use `/register-group` first.
Output is a JSON envelope `{ ok, jid, outboxId }`; surface the `outboxId` briefly so the user can track delivery via `/claw-status`.
