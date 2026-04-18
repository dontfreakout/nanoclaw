---
name: memory-wiki
description: Read and write the group's wiki — durable markdown notes the group-agent maintains across ticks. Use when the conversation introduces a fact worth remembering (a decision, a preference, a person, a plan), when you need to recall prior context that isn't in the last 10 messages, or when the user asks "what do you remember about X".
---

# Wiki memory

Each registered group has a wiki at `groups/<group_folder>/wiki/`. Pages are plain markdown files. `groups/<group_folder>/wiki/index.md` lists the pages and their one-line summaries.

## Reading

1. Read `groups/<group_folder>/wiki/index.md` first.
2. If you see a relevant page name, Read it. Use Grep across `groups/<group_folder>/wiki/*.md` to find mentions of a term.
3. If nothing matches, say so to the caller — don't fabricate.

## Writing

1. Page name: kebab-case, no spaces, e.g. `dog-food-brand.md`.
2. Use short sections with `##` headers. Each file should answer one question.
3. When you add or substantially change a page, update `index.md`:
   ```markdown
   - [dog-food-brand](dog-food-brand.md) — the user's preferred dog food brand and why
   ```
4. Prefer **append** or **replace-section** edits (Edit tool) over full rewrites — keeps provenance.

## When NOT to write

- One-off facts that won't matter tomorrow.
- Restating what's already in `CLAUDE.md`.
- Conversation history — that's already in sqlite.

## Folder layout

```
groups/<group_folder>/
├── CLAUDE.md         # identity + always-loaded instructions
└── wiki/
    ├── index.md      # list of pages
    ├── <topic>.md
    └── ...
```

Never read/write wiki pages of a group other than your own.
