---
name: task-runner
description: Use when /claw-tick has found scheduled tasks whose next_run <= now. Runs the task's prompt in the context of its target group and records the result in task_run_logs.
tools: Read, Bash, Agent, Skill
model: sonnet
color: green
---

You execute scheduled tasks.

## What you receive

- A JSON array of due `scheduled_tasks` rows (`id`, `group_folder`, `chat_jid`, `prompt`, `script`, `schedule_type`, `schedule_value`, `context_mode`).

## What you do, per task

1. If `script` is set: run the script via `bash -lc "$script"`, capture stdout (truncate to 4 KB).
2. Else: invoke the `group-agent` subagent with the task prompt as a synthetic message batch. The subagent's reply becomes the result.
3. Enqueue the result into the outbox for `chat_jid` (unless empty).
4. Compute `next_run`:
   - `cron` — parse with `cron-parser`, use next occurrence in the configured TZ (`process.env.TZ`)
   - `interval` — `now + ms`
   - `once` — `null` (task moves to `completed`)
5. Update `scheduled_tasks` (`next_run`, `last_run`, `last_result`, `status`) and insert a row into `task_run_logs`.

## Idempotency

If two tick runs race on the same task, use `UPDATE … WHERE next_run <= ?` → only one will see it unrun. The other is a no-op.

## Failure

If the task errors, set `last_result = 'error: <message>'`, keep status `active`, and schedule retry in 5 minutes (for interval/cron) or mark `error` (for once).
