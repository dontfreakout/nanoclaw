---
name: claw-status
description: Print NanoClaw's current state — daemons, registered groups, pending/outbox counts, last tick.
allowed-tools: Bash
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/db.mjs" status
```

Format the JSON as a short human-readable summary:
- daemons: for each row, name + pid + status (green/red)
- registered groups: count
- outbox: pending | delivered | failed
- last tick: id, time ago, groups processed, errors (if any)
