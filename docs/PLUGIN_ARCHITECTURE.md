# NanoClaw as a Claude Code Plugin

Status: design doc for the `inside-claude` branch rework.

## Motivation

The existing NanoClaw runs a Node.js orchestrator (`src/index.ts`) that polls messaging channels, stores messages in SQLite, and spawns the Claude Code CLI inside Docker/Apple containers for every registered group. Each container runs its own Claude Code session.

This design moves the orchestrator *inside* a single long-running Claude Code session:

- The Claude Code session **is** the assistant — no per-group containers.
- `/loop` drives the main tick, replacing the `while (true)` in `startMessageLoop`.
- Per-group isolation is done with **subagents** (one invocation per tick), passing the group's `CLAUDE.md` + wiki pages as context.
- Channel connectivity (WhatsApp WebSocket, Slack Socket Mode) stays in small background **Node daemons**, because those need persistent connections. They bridge channel ↔ SQLite; nothing more.
- Memory is split: **SQLite** for structured state (messages, sessions, tasks, registered groups), **wiki** (markdown files under `groups/{group}/wiki/`) for durable notes the agent writes/reads by name.

## Plugin Layout

```
plugin/                             # installed as a Claude Code plugin
├── plugin.json                     # manifest
├── hooks.json                      # SessionStart / Stop / UserPromptSubmit
├── commands/
│   ├── claw-tick.md                # one iteration of the main loop
│   ├── claw-start.md               # bring up daemons + start /loop /claw-tick
│   ├── claw-status.md              # show channel + queue state
│   ├── claw-stop.md                # shut daemons down
│   └── register-group.md           # register a chat as a group
├── agents/
│   ├── group-agent.md              # per-group assistant (invoked per tick)
│   ├── channel-router.md           # decides which channel/group a message came from
│   └── task-runner.md              # runs scheduled tasks
├── skills/
│   ├── memory-wiki/SKILL.md        # read/write wiki pages
│   ├── memory-sqlite/SKILL.md      # query/update sqlite state
│   ├── send-message/SKILL.md       # write to outbox
│   ├── check-pending/SKILL.md      # list pending inbound messages per group
│   └── manage-tasks/SKILL.md       # create/pause/cancel scheduled tasks
└── scripts/
    ├── db.mjs                      # thin wrapper around src/db.ts (reused)
    ├── whatsapp-daemon.mjs         # spawned as background process
    ├── slack-daemon.mjs            # spawned as background process
    └── outbox-worker.mjs           # polls outbox, calls daemons to deliver
```

`plugin/` is a top-level directory (not under `.claude/`) because `.claude/` is treated as read-only sandbox territory in this repo's dev environment. A user installs it with:

```
/plugin install ./plugin
```

or by symlinking into `~/.claude/plugins/nanoclaw/`.

## Data Flow (one tick)

```
┌──────────────┐   inbound    ┌─────────────┐     SELECT pending    ┌──────────────┐
│ WhatsApp API │◀──────────▶──│ whatsapp    │──────writes rows────▶ │              │
├──────────────┤              │ daemon      │                       │              │
│ Slack API    │◀──────────▶──│ slack       │──────writes rows────▶ │   SQLite     │
└──────────────┘              │ daemon      │                       │ (messages,   │
                              └─────────────┘                       │  outbox,     │
                                                                    │  tasks, ...) │
                                                                    │              │
                                     ┌──────────────────────────────│              │
                                     │                              └──────────────┘
                              ┌──────▼────────┐                             ▲
                              │ /claw-tick    │                             │
                              │ command       │                             │
                              │   · pull new  │                             │
                              │     msgs      │                             │
                              │   · for each  │                             │
                              │     group →   │                             │
                              │     Agent(    │                             │
                              │      group-   │◀── reads wiki/CLAUDE.md     │
                              │      agent)   │                             │
                              │   · write     │                             │
                              │     response  │────writes outbox row────────┘
                              │     to outbox │
                              └───────────────┘
                                     │
                                     │ (next /loop iteration)
                                     ▼

                              ┌──────────────┐
                              │ outbox-worker│────picks outbox rows──▶ daemon HTTP endpoint
                              └──────────────┘
```

- `/loop 15s /claw-tick` or `/loop /claw-tick` (dynamic pacing) keeps the cycle going.
- The tick is idempotent — if no new messages, it exits quickly.

## Memory Model

### SQLite (reused from `src/db.ts`)

Existing tables kept verbatim:
- `messages` — channel message history
- `chats` — chat metadata
- `registered_groups` — registered groups and their folder / trigger
- `sessions` — (still used to dedupe ticks — maps group → last responded message)
- `scheduled_tasks`, `task_run_logs`
- `router_state` — cursors

New tables added in plugin migrations:
- `outbox(id, chat_jid, text, status, created_at, delivered_at, error)` — messages the agent wants to send; daemons poll this
- `wiki_pages(group, name, content, updated_at)` — optional DB-backed wiki cache (primary storage is still files)
- `tick_log(id, started_at, ended_at, groups_processed, messages_handled, status, error)` — one row per `/claw-tick`

### Wiki

Under each group folder: `groups/{group}/wiki/*.md`. Pages are free-form markdown the agent maintains. The index page `groups/{group}/wiki/index.md` lists all pages.

Skills exposed:
- `memory-wiki` read — returns page contents by name or fuzzy match
- `memory-wiki` write — append or replace a page; auto-bumps index

Principle: **sqlite is the authoritative state, wiki is the authoritative knowledge.** Structured things (timestamps, cursors, schedules) live in sqlite. Free-form notes, decisions, facts live in the wiki.

## Tick Algorithm (inside `/claw-tick`)

```
1. If daemons not running → exit with error advising /claw-start
2. Read pending inbound messages per registered group (reuse getMessagesSince)
3. For each group with new messages AND (isMain OR trigger matched):
     a. Gather context: group CLAUDE.md, relevant wiki pages, message batch
     b. Invoke group-agent subagent with that context
     c. Strip <internal> tags from subagent output
     d. Insert row into outbox(chat_jid, text, status='pending')
     e. Advance cursor (last_agent_timestamp)
4. Run due scheduled tasks (poll scheduled_tasks.next_run <= now)
5. Outbox worker (separate Node process) picks up pending rows and hands off to the right daemon
6. Write tick_log row
7. Emit a one-line status for the /loop monitor
```

## Channels as Daemons

WhatsApp and Slack keep persistent connections, so they run as subprocesses:

- `scripts/whatsapp-daemon.mjs` — wraps `src/channels/whatsapp.ts`, exposes HTTP on `127.0.0.1:<port>` with:
  - `POST /send { chatJid, text }` — send a message
  - health via `GET /ping`
- `scripts/slack-daemon.mjs` — same shape, wraps `src/channels/slack.ts`

Inbound messages go straight into sqlite via `storeMessage()` (imported from `src/db.ts`). The daemons never call Claude — they just bridge.

Process lifecycle: `claw-start` command spawns them detached, writes PIDs to `data/daemons.json`. `claw-status` pings them. `claw-stop` sends SIGTERM. A `SessionStart` hook runs `claw-start` automatically.

## Hooks

`plugin/hooks.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": "scripts/bootstrap.mjs" }],
    "Stop":        [{ "command": "scripts/on-stop.mjs" }],
    "UserPromptSubmit": [{ "command": "scripts/annotate-prompt.mjs" }]
  }
}
```

- **SessionStart** — ensure daemons running, init sqlite, print status.
- **Stop** — flush outbox before the session pauses.
- **UserPromptSubmit** — optionally annotate the prompt with "X pending messages" so the user knows without asking.

## Loop Integration

User runs once: `/loop /claw-tick` (or `/loop 10s /claw-tick`).
Ralph-loop's self-pacing variant lets the agent decide the interval (default 30s idle, 5s burst during activity).

Escape valve: typing anything during /loop interrupts it.

## Migration

- Existing `src/` code is kept — the daemons import from it directly (no rewrites of proven channel code).
- `src/index.ts`'s orchestration is *replaced* by the plugin tick, but its helpers (`processGroupMessages`, `runAgent`, `loadState`) become small building blocks the tick re-uses.
- `groups/` folder layout unchanged; `wiki/` is a new subfolder.
- A one-time migration skill (`/migrate-to-plugin`) converts existing installs by:
  - Stopping the launchd/systemd service
  - Keeping the sqlite DB in place (schema is additive)
  - Starting the daemons under the plugin

## Out of Scope (first cut)

- Discord, Gmail, Telegram — the existing skills still work; plugin bridge can be added later per channel.
- Remote-control (`/remote-control`) — skipped.
- Container-based sandboxing — the whole point is to skip containers; if per-group isolation is needed later, use subagents with restricted tools.
