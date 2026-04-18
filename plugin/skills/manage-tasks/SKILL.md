---
name: manage-tasks
description: Create, list, pause, resume, and cancel scheduled tasks in the NanoClaw task scheduler. Use when the user asks for a reminder, a recurring prompt, or a one-off delayed action. Tasks fire in the context of a specific registered group.
---

# Scheduled tasks

Tasks live in `scheduled_tasks` (see `memory-sqlite`). They run via the `task-runner` subagent when `/claw-tick` finds them due.

## Create

```bash
TASK_ID="task-$(date +%s)-$(openssl rand -hex 4)"
sqlite3 store/messages.db "
  INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
  VALUES
    ('$TASK_ID', '<folder>', '<jid>', '<prompt>', 'cron|interval|once', '<value>', 'isolated|group', '<iso_next_run>', 'active', '$(date -u +%FT%TZ)');
"
```

Schedule types:
- `cron` — `schedule_value` is a cron expression, evaluated in `$TZ` (see `src/timezone.ts`).
- `interval` — milliseconds between runs. `next_run = now + ms`.
- `once` — `schedule_value` is an ISO timestamp. After running, task moves to `completed`.

Context modes:
- `isolated` — runs as a fresh conversation; no prior message history pulled in.
- `group` — task-runner loads the group's recent messages as context.

## List

```bash
sqlite3 -json store/messages.db "
  SELECT id, prompt, schedule_type, schedule_value, next_run, status
  FROM scheduled_tasks
  WHERE group_folder = '<folder>'
  ORDER BY COALESCE(next_run, created_at);
"
```

## Pause / Resume / Cancel

```bash
sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'paused' WHERE id = '<id>';"
sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'active' WHERE id = '<id>';"
sqlite3 store/messages.db "DELETE FROM task_run_logs WHERE task_id = '<id>'; DELETE FROM scheduled_tasks WHERE id = '<id>';"
```

## Authorization

- A per-group agent may only create/modify tasks where `group_folder == <own folder>`.
- The main group's agent may create tasks for any group.

## Validation

- Reject cron expressions that don't parse with `cron-parser` — don't store them.
- Reject intervals <= 10 seconds (denial-of-service risk).
- For `once`, refuse timestamps more than 1 year out or in the past.
