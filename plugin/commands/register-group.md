---
name: register-group
description: Register a chat as a NanoClaw group, creating its folder and wiki scaffold.
argument-hint: <jid> <folder> [trigger] [--main]
allowed-tools: Bash, Read
---

Register $ARGUMENTS as a NanoClaw group.

## Arguments

- `<jid>` — chat identifier (WhatsApp: `<digits>@g.us` or `<digits>@s.whatsapp.net`; Slack: `slack:<channelId>`)
- `<folder>` — folder name under `groups/`. Must match `^[a-zA-Z0-9_-]+$`. `global` is reserved.
- `[trigger]` — trigger phrase; defaults to `@<AssistantName>`
- `[--main]` — flag if this is the user's main always-on group (no trigger required)

## Steps

1. If $ARGUMENTS is empty, call `check-pending` to list existing chats and ask the user which to register.
2. Run the registration script (one shot, validates + inserts + scaffolds folder):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/register-group.mjs" $ARGUMENTS
   ```
3. Report the result:
   - On success: show the folder path, trigger, and whether it's the main group. Suggest the user open `groups/<folder>/CLAUDE.md` to write an identity.
   - On failure: surface the error (validation, folder conflict, etc.).

The script creates `groups/<folder>/CLAUDE.md` (from `groups/main` or `groups/global` template), an empty `groups/<folder>/wiki/` with an `index.md`, and inserts a row into `registered_groups`.
