---
name: claw-stop
description: Stop NanoClaw — halt the channel daemons and leave the /loop.
allowed-tools: Bash
---

Shut NanoClaw down cleanly.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.mjs"
```

Then tell the user:
- Which daemons were stopped and any pending outbox count
- That the current `/loop` can be exited by typing anything

(If invoked inside a `/loop`, this does NOT stop the loop itself — the user exits the loop by typing.)
