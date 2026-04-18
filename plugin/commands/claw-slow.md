---
name: claw-slow
description: Adjust how often /loop runs /claw-tick. Use when the assistant is being too chatty or burning too many tokens, or when you want it to stay extra responsive. Takes a preset or explicit min/max in seconds.
argument-hint: [burst|normal|slow|away|clear | --min <s> --max <s> [--until <iso>]]
allowed-tools: Bash
---

Slow down or speed up the main loop.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/slow.mjs" $ARGUMENTS
```

## Presets

- `burst` → min 30s, max 60s (very responsive — use during active work)
- `normal` → clears override (adaptive default)
- `slow` → min 10m, max 30m (light touch — use while working on something else)
- `away` → min 30m, max 60m (background — overnight / weekend)
- `clear` → remove override

## Explicit

```
/claw-slow --min 300 --max 1200
/claw-slow --min 600 --until 2026-04-19T09:00:00Z
```

The tick's adaptive pacing still runs; the override just clamps its output.

Output is a JSON envelope; summarize for the user as "paced at <min>-<max>s".
