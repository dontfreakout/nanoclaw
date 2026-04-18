/**
 * Validates the plugin layout: manifest, hooks, referenced scripts, and
 * skill frontmatter. Catches typos that would only surface at load time
 * inside Claude Code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf-8'));
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^"|"$/g, '');
  }
  return fields;
}

describe('plugin.json', () => {
  it('is valid JSON with required fields', () => {
    const manifest = readJson('plugin.json');
    expect(manifest.name).toBe('nanoclaw');
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.description).toBe('string');
  });
});

describe('hooks.json', () => {
  let hooks;
  it('is valid JSON with a hooks object', () => {
    hooks = readJson('hooks.json');
    expect(hooks).toHaveProperty('hooks');
  });

  it('every referenced script exists and is executable', () => {
    hooks = readJson('hooks.json');
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const cmd = hook.command;
          expect(cmd, `${event} hook`).toBeTruthy();
          const resolved = cmd
            .replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_DIR)
            .split(' ')[0];
          expect(fs.existsSync(resolved), `hook command for ${event}: ${resolved}`).toBe(true);
        }
      }
    }
  });
});

describe('commands', () => {
  const dir = path.join(PLUGIN_DIR, 'commands');

  it('every command has a name and description in frontmatter', () => {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(md);
      expect(fm, `frontmatter in ${file}`).toBeTruthy();
      expect(fm.name, `name in ${file}`).toBeTruthy();
      expect(fm.description, `description in ${file}`).toBeTruthy();
    }
  });

  it('every command file name matches its "name" field', () => {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(md);
      expect(fm.name).toBe(file.replace(/\.md$/, ''));
    }
  });
});

describe('agents', () => {
  const dir = path.join(PLUGIN_DIR, 'agents');

  it('every agent has name, description, and tools', () => {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(md);
      expect(fm, `frontmatter in ${file}`).toBeTruthy();
      expect(fm.name, `name in ${file}`).toBeTruthy();
      expect(fm.description, `description in ${file}`).toBeTruthy();
      expect(fm.tools, `tools in ${file}`).toBeTruthy();
    }
  });

  it('agent tools lists only known Claude Code tool names', () => {
    // Claude Code built-in tool list — keep in sync with platform docs.
    const KNOWN_TOOLS = new Set([
      'Agent',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Skill',
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'TaskStop',
      'TaskOutput',
      'WebFetch',
      'WebSearch',
      'Write',
      'NotebookEdit',
    ]);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(md);
      const tools = (fm.tools || '').split(',').map((t) => t.trim()).filter(Boolean);
      expect(tools.length, `${file} tool list`).toBeGreaterThan(0);
      for (const t of tools) {
        expect(KNOWN_TOOLS.has(t), `${file} references unknown tool: ${t}`).toBe(true);
      }
    }
  });

  it('agent file name matches name frontmatter', () => {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(md);
      expect(fm.name).toBe(file.replace(/\.md$/, ''));
    }
  });
});

describe('skills', () => {
  const dir = path.join(PLUGIN_DIR, 'skills');

  it('every skill subdir has a SKILL.md with name + description', () => {
    for (const entry of fs.readdirSync(dir)) {
      const skillMd = path.join(dir, entry, 'SKILL.md');
      expect(fs.existsSync(skillMd), `SKILL.md in ${entry}`).toBe(true);
      const md = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(md);
      expect(fm?.name, `name in ${entry}`).toBe(entry);
      expect(fm?.description, `description in ${entry}`).toBeTruthy();
    }
  });

  it('skill descriptions are substantive (>80 chars)', () => {
    for (const entry of fs.readdirSync(dir)) {
      const skillMd = path.join(dir, entry, 'SKILL.md');
      const md = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(md);
      expect(
        (fm?.description || '').length,
        `description length in ${entry}`,
      ).toBeGreaterThan(80);
    }
  });

  it('skill descriptions reference trigger words ("use when...")', () => {
    for (const entry of fs.readdirSync(dir)) {
      const skillMd = path.join(dir, entry, 'SKILL.md');
      const md = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(md);
      const desc = (fm?.description || '').toLowerCase();
      // Claude reads skill descriptions to decide when to activate;
      // the description should describe a triggering situation, not just a name.
      const usefulHints = [
        'use when',
        'use this',
        'when the',
        'when you',
        'when a ',
        'use the',
      ];
      const hasHint = usefulHints.some((h) => desc.includes(h));
      expect(hasHint, `${entry} description should include a "use when" hint`).toBe(true);
    }
  });

  it('skill descriptions do not contain placeholder TODO markers', () => {
    const placeholders = ['todo', 'tbd', 'xxx', 'fixme', 'lorem'];
    for (const entry of fs.readdirSync(dir)) {
      const skillMd = path.join(dir, entry, 'SKILL.md');
      const md = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(md);
      const desc = (fm?.description || '').toLowerCase();
      for (const p of placeholders) {
        expect(desc.includes(p), `${entry} description contains "${p}"`).toBe(false);
      }
    }
  });
});

describe('scripts', () => {
  it('every script referenced from a .md command exists', () => {
    const cmdDir = path.join(PLUGIN_DIR, 'commands');
    const scriptDir = path.join(PLUGIN_DIR, 'scripts');
    const refRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z0-9_-]+\.(?:mjs|ts))/g;
    for (const file of fs.readdirSync(cmdDir)) {
      if (!file.endsWith('.md')) continue;
      const md = fs.readFileSync(path.join(cmdDir, file), 'utf-8');
      for (const match of md.matchAll(refRe)) {
        const scriptPath = path.join(scriptDir, match[1]);
        expect(fs.existsSync(scriptPath), `${file} references missing ${match[1]}`).toBe(true);
      }
    }
  });
});
