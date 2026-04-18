---
name: claw-migrate
description: Migrate an existing classic NanoClaw install (launchd / systemd service) to the Claude Code plugin. Non-destructive — stops the classic service, keeps the sqlite DB, and prints next steps.
argument-hint: [--dry-run]
allowed-tools: Bash
---

Run migration.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-from-classic.mjs" $ARGUMENTS
```

## What it does

1. Looks for a classic service:
   - macOS: `~/Library/LaunchAgents/com.nanoclaw.plist`
   - Linux: `~/.config/systemd/user/nanoclaw.service` or `/etc/systemd/system/nanoclaw.service`
2. Looks for manually-started processes (`tsx src/index.ts`, `node dist/index.js`).
3. Reports on `store/messages.db` — size, whether it will be reused.
4. Stops the classic service (skip with `--dry-run`).
5. Applies the plugin's schema migration (adds `outbox`, `tick_log`, `wiki_pages`, `daemon_state`). Core tables are untouched.
6. Prints next steps.

## Output

A JSON report the user can inspect. Summarize it for them as:

- Platform + what was detected
- Whether the classic service was stopped
- Any manual processes still running (tell the user to kill them)
- Final action: run `/claw-start`

The script never deletes data. It's safe to re-run.
