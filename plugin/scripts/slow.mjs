#!/usr/bin/env node
/**
 * /claw-slow — set or clear the pacing override for /claw-tick.
 *
 * Usage:
 *   slow.mjs <preset>                         (burst | normal | slow | away | clear)
 *   slow.mjs --min <s> [--max <s>] [--until <iso>]
 */
import { openDb } from './db.mjs';
import { presetToOverride, setOverride, loadOverride } from './pacing.mjs';

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { preset: null, min: null, max: null, untilIso: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min') out.min = Number(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--until') out.untilIso = argv[++i];
    else if (!a.startsWith('--')) out.preset = a;
  }
  return out;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.preset && args.min === null && args.max === null) {
    const db = openDb();
    console.log(JSON.stringify({ ok: true, current: loadOverride(db) }, null, 2));
    return;
  }

  const db = openDb();
  let override;
  if (args.preset) {
    const preset = presetToOverride(args.preset);
    if (args.preset === 'clear' || args.preset === 'normal') {
      setOverride(db, {});
      console.log(JSON.stringify({ ok: true, cleared: true }));
      return;
    }
    if (!preset) fail(`unknown preset: ${args.preset}`);
    override = { ...preset, untilIso: args.untilIso || null };
  } else {
    override = {
      min: args.min ?? undefined,
      max: args.max ?? undefined,
      untilIso: args.untilIso || null,
    };
  }

  const result = setOverride(db, override);
  console.log(JSON.stringify({ ok: true, override: result }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
