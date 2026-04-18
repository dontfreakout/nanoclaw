---
name: claw-tick
description: One tick of NanoClaw. Checks pending messages, dispatches per-group subagents, flushes outbox. Driven by /loop — aim for zero tokens on idle ticks.
allowed-tools: Bash, Agent
---

Run one tick. **Keep output minimal** — this fires many times per hour under `/loop` and every line costs cache tokens.

## Fast path (idle)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" prepare
```

Parse the output. If `groups` is empty:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" finalize <tickId> 0 0
```

Reply **one line only**: `idle · next in <pacing.seconds>s` (from finalize's `pacing.seconds` field). Nothing else. Do NOT load any skill, invoke any subagent, or read any file.

## Active path

For each group in `prepare`'s output:

1. Invoke the `group-agent` subagent (Agent tool) with `folder`, `isMain`, and `messagesXml`. Capture its reply string.
2. Commit both the reply and the cursor advance in one atomic call:
   ```bash
   echo '{"jid":"<jid>","latestTimestamp":"<ts>","reply":"<reply>"}' \
     | node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" process-group
   ```
   On subagent error, set `"error":"<msg>"` instead of `reply` — the cursor won't advance and the messages retry next tick.

When done with groups, check due scheduled tasks:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" due
```

If non-empty, invoke the `task-runner` subagent with the JSON.

Finalize and read the pacing suggestion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" finalize <tickId> <groupsProcessed> <messagesHandled>
```

Reply in **one line**: `tick #<id> · <groups> groups · <msgs> msgs · next in <pacing.seconds>s`.

## Rules

- **Never read files** (CLAUDE.md, wiki pages) in this command — the group-agent subagent does that.
- **Never include raw message content** in your reply to the user — just counts.
- If `prepare` or `finalize` errors, emit `error: <msg>` in one line and let `/loop` continue.
- Pacing: respect `pacing.seconds` from finalize; `/loop` dynamic mode uses it to self-pace.

## Adaptive pacing

The tick tells `/loop` how long to wait before the next invocation. Active ticks → 30s; idle ticks climb a ladder (120s → 270s → 15m → 30m). A user-set override via `/claw-slow` clamps the result. Idle ticks should finish in well under a second.
