# NanoClaw — Claude Code plugin

A rework of NanoClaw as a Claude Code plugin. See [`../docs/PLUGIN_ARCHITECTURE.md`](../docs/PLUGIN_ARCHITECTURE.md) for the full design.

## What it is

The classic NanoClaw is a Node.js orchestrator that polls messaging channels and spawns the Claude Code CLI inside Docker/Apple containers, one per group. **This plugin** runs the orchestrator *inside* a single Claude Code session instead:

- `/loop /claw-tick` drives the main loop (replacing `startMessageLoop` in `src/index.ts`).
- Per-group isolation is done with **subagents** (`plugin/agents/group-agent.md`), not containers.
- **WhatsApp** and **Slack** channel connectivity stays in small background Node daemons — those need persistent connections. They bridge channel ↔ sqlite; they don't call Claude.
- Memory: **SQLite** for structured state (messages, sessions, tasks, outbox), **markdown wiki** (`groups/<folder>/wiki/*.md`) for free-form notes the agent maintains.

## Install

### As a Claude Code plugin (recommended)

```bash
# From the nanoclaw repo root
npm install                                 # installs peer deps (baileys, bolt, sqlite, tsx)
ln -s "$(pwd)/plugin" ~/.claude/plugins/nanoclaw
# restart Claude Code
```

Then in a Claude Code session inside the nanoclaw repo:

```
/claw-migrate           # if migrating from the classic service (skip on fresh install)
/claw-start             # boot daemons + enter /loop /claw-tick
```

Check state any time with `/claw-status`. Stop with `/claw-stop`.

### Dev install (without the symlink)

```bash
/plugin install ./plugin
```

Same behaviour — Claude Code discovers commands/agents/skills from `plugin/`.

## Credentials

Put these in `.env` at the repo root:

| Variable | Channel | Required? |
|-|-|-|
| `ASSISTANT_NAME` | all | no (default `Andy`) |
| `TZ` | scheduled tasks, timestamps | no (default `UTC`) |
| `SLACK_APP_TOKEN` | Slack | yes for Slack (Socket Mode) |
| `SLACK_BOT_TOKEN` | Slack | yes for Slack |
| `MAX_MESSAGES_PER_PROMPT` | tick | no (default 10) |

WhatsApp authenticates on first daemon boot via QR code or pairing code. Auth state lives in `store/wa_auth/`. See `src/whatsapp-auth.ts`.

Daemons without credentials report `missing-credentials` at `/claw-start` and are skipped cleanly — the plugin still works for the channels that are configured.

## Common operations

### Register a chat

Find the chat's JID in `/claw-status` (or via the channel's own tooling), then:

```
/register-group <jid> <folder>               # normal group (trigger-gated)
/register-group <jid> main --main            # your always-on main group
```

Optional `[trigger]` arg overrides the default `@<AssistantName>`.

### Schedule a task

From inside the main group, tell the assistant:

> Remind me every weekday at 9am to do the standup.

The group-agent will use the `manage-tasks` skill. To do it directly:

```bash
echo '{
  "groupFolder": "main",
  "chatJid": "me@s.whatsapp.net",
  "prompt": "Good morning, time for standup!",
  "scheduleType": "cron",
  "scheduleValue": "0 9 * * 1-5"
}' | node plugin/scripts/tasks.mjs create
```

List / pause / cancel:

```bash
node plugin/scripts/tasks.mjs list main
node plugin/scripts/tasks.mjs pause <task-id>
node plugin/scripts/tasks.mjs cancel <task-id>
```

### Inspect memory

Wiki:

```bash
node plugin/scripts/wiki.mjs list main
node plugin/scripts/wiki.mjs read main dog-food
echo "# Dog food\n\nUser prefers Orijen." | node plugin/scripts/wiki.mjs write main dog-food
```

SQLite state summary:

```bash
node plugin/scripts/status.mjs            # human-readable
node plugin/scripts/status.mjs --json     # raw
```

### Prune old data

```bash
node plugin/scripts/prune.mjs --dry-run
node plugin/scripts/prune.mjs             # actually delete
node plugin/scripts/prune.mjs --outbox-days 7 --tick-days 3
```

Only delivered/failed outbox rows, completed tick logs, and task run logs are pruned. Messages and active tasks are never touched.

## Layout

```
plugin/
├── plugin.json               — Claude Code plugin manifest
├── package.json              — independent package definition (peer deps)
├── hooks.json                — SessionStart / Stop / UserPromptSubmit hooks
├── README.md                 — this file
├── vitest.config.mjs         — plugin-only test filter
├── structure.test.mjs        — manifest/frontmatter/script reference validation
├── commands/                 — slash commands
├── agents/                   — subagent definitions
├── skills/                   — SKILL.md instruction bundles
└── scripts/
    ├── db.mjs                — sqlite helpers + CLI
    ├── wiki.mjs              — wiki helpers + CLI
    ├── format.mjs            — XML message format (port of src/router.ts)
    ├── trigger.mjs           — trigger regex (port of src/config.ts)
    ├── tasks.mjs             — scheduled-task CRUD CLI
    ├── tick.mjs              — /claw-tick orchestration
    ├── register-group.mjs    — /register-group implementation
    ├── migrate-from-classic.mjs — /claw-migrate implementation
    ├── status.mjs            — /claw-status formatter
    ├── prune.mjs             — data hygiene
    ├── bootstrap.mjs         — SessionStart hook + /claw-start
    ├── on-stop.mjs           — Stop hook + /claw-stop
    ├── annotate-prompt.mjs   — UserPromptSubmit hook
    ├── whatsapp-daemon.ts    — WhatsApp persistent connection (Baileys)
    ├── slack-daemon.ts       — Slack persistent connection (Bolt Socket Mode)
    ├── outbox-worker.mjs     — catch-all outbox retry worker
    └── *.test.mjs            — vitest (16 files, 152 tests)
```

## Running tests

```bash
npx vitest run plugin/           # plugin only (fast)
npm run test --prefix plugin     # same, via plugin/package.json
npx vitest run                   # full repo
```

## Troubleshooting

**Daemons show `missing-credentials`:** put `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN` in `.env`.

**Plugin doesn't appear in Claude Code:** confirm the symlink — `ls -l ~/.claude/plugins/nanoclaw` should resolve to this repo's `plugin/`. Then restart Claude Code.

**`tsx: command not found`:** run `npm install` at the repo root.

**Messages not being delivered:** `node plugin/scripts/db.mjs outbox-pending` — if rows are stuck pending, check `logs/whatsapp.log` and `logs/slack.log`. The outbox-worker retries for ~10 attempts before marking `failed`.

**Cursor got stuck:** delete and recreate with `node plugin/scripts/db.mjs advance-cursor <jid> <iso_ts>`.

## Limitations

- Telegram, Discord, Gmail daemons — not ported yet.
- Remote control (`/remote-control`) — intentionally dropped.
- Image vision, voice transcription, PDF reader — ride as the old NanoClaw skills; not yet integrated.
