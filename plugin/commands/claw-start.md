---
name: claw-start
description: Start NanoClaw — boot the channel daemons (WhatsApp + Slack) and enter the /loop that runs /claw-tick.
argument-hint: [interval]
allowed-tools: Bash, Read, Skill
---

Start NanoClaw in the current Claude Code session.

## Steps

1. Run bootstrap (idempotent):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs"
   ```
   This applies plugin schema, starts the WhatsApp + Slack daemons if they aren't already running, and starts the outbox worker. PIDs are stored in `data/daemons.json`.

2. Print daemon status:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" status
   ```

3. Start the main loop. If $ARGUMENTS is empty, use self-paced dynamic mode:
   - Run `/loop /claw-tick` (dynamic pacing — agent picks its own interval).
   - Otherwise run `/loop $ARGUMENTS /claw-tick`.

Tell the user:
- Which daemons came up, which are missing credentials
- That the loop is running and how to stop it (`/claw-stop`)
- How to register a chat: send `@<AssistantName> register` from the chat itself, or run `/register-group`.
