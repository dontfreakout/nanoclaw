---
name: claw-logs
description: Tail the daemon log files. Use when WhatsApp/Slack isn't connecting, messages aren't arriving, or the outbox is stuck — check the logs before making changes.
argument-hint: [<daemon>] [errors] [<lines>]
allowed-tools: Bash
---

Show recent daemon log output.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/logs.mjs" $ARGUMENTS
```

Accepted arguments (in any order):

- `whatsapp` / `slack` / `outbox-worker` — a single daemon (default: all three)
- `errors` / `err` — read the stderr log (`<daemon>.err.log`)
- `N` (a number) — how many tail lines (default: 20)
- `--list` — list log files only

Examples:

- `/claw-logs` → last 20 lines from each log
- `/claw-logs whatsapp 100` → last 100 lines from `whatsapp.log`
- `/claw-logs slack errors` → `slack.err.log`

After the output, summarize any errors you see in 1-2 sentences and suggest a fix (e.g. credentials missing, connection reset, rate limit).
