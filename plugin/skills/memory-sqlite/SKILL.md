---
name: memory-sqlite
description: Query NanoClaw's sqlite state (messages, registered groups, scheduled tasks, outbox, tick log). Read-only by default. Use when the agent needs to look up prior message history beyond the tick batch, check whether a task exists, or inspect outbox state.
---

# SQLite memory

The database lives at `store/messages.db`. Tables (see `docs/PLUGIN_ARCHITECTURE.md` for full schema):

- `messages(id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_*)`
- `chats(jid, name, last_message_time, channel, is_group)`
- `registered_groups(jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)`
- `scheduled_tasks(id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, next_run, last_run, status, context_mode)`
- `task_run_logs(id, task_id, run_at, duration_ms, status, result, error)`
- `outbox(id, chat_jid, text, status, created_at, delivered_at, error, attempts)`
- `tick_log(id, started_at, ended_at, groups_processed, messages_handled, status, error)`
- `wiki_pages(group_folder, name, content, updated_at)` — optional cache; wiki files on disk are authoritative
- `router_state(key, value)` — `last_timestamp`, `last_agent_timestamp`

## Query

```bash
sqlite3 store/messages.db 'SELECT * FROM registered_groups;'
```

Or use `plugin/scripts/db.mjs` helpers:

```bash
node plugin/scripts/db.mjs status
node plugin/scripts/db.mjs pending "$ASSISTANT_NAME"
```

## Write rules

- Never INSERT/UPDATE `messages` — the daemons own that table.
- Never UPDATE `router_state.last_agent_timestamp` except via `db.mjs advance-cursor`. Direct writes risk losing cursors from other groups.
- Outbox writes must go through `db.mjs outbox-enqueue` so timestamps and attempts are set correctly.

## Safety

- Wrap multi-statement writes in a transaction.
- Always filter by `group_folder` when the caller is a single group agent — groups must not read or write other groups' tasks/outbox rows.
