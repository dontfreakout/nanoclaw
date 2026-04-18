#!/usr/bin/env node
/**
 * Status formatter — turns the JSON from db.mjs#status into a short,
 * human-readable summary. Used by /claw-status and for the /claw-start banner.
 *
 * Run directly to pretty-print:
 *   node plugin/scripts/status.mjs
 */
import { openDb } from './db.mjs';

export function formatStatus(status, { now = Date.now() } = {}) {
  const lines = [];

  // Daemons
  const daemonRows = Array.isArray(status.daemons) ? status.daemons : [];
  if (daemonRows.length === 0) {
    lines.push('Daemons: none');
  } else {
    const daemonLine = daemonRows
      .map((d) => {
        const dot = d.status === 'running' ? '●' : '○';
        return `${dot} ${d.name}${d.pid ? `(${d.pid})` : ''}`;
      })
      .join('  ');
    lines.push(`Daemons: ${daemonLine}`);
  }

  // Groups
  const groups = status.groups ?? 0;
  lines.push(`Groups: ${groups}`);

  // Outbox
  const ob = status.outbox || { pending: 0, delivered: 0, failed: 0 };
  lines.push(
    `Outbox: ${ob.pending} pending · ${ob.delivered} delivered · ${ob.failed} failed`,
  );

  // Last tick
  if (status.lastTick) {
    const t = status.lastTick;
    const age = t.ended_at ? humanAge(now - new Date(t.ended_at).getTime()) : 'running';
    const summary =
      t.status === 'error'
        ? `error (${t.error || 'unknown'})`
        : `${t.groups_processed || 0} groups · ${t.messages_handled || 0} msgs`;
    lines.push(`Last tick: #${t.id} · ${age} · ${summary}`);
  } else {
    lines.push('Last tick: (none)');
  }

  return lines.join('\n');
}

export function humanAge(ms) {
  if (ms < 0) return '0s ago';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function collectStatus(db) {
  return {
    outbox: {
      pending: db.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'`).get().c,
      delivered: db.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'delivered'`).get().c,
      failed: db.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'failed'`).get().c,
    },
    groups: db.prepare(`SELECT COUNT(*) AS c FROM registered_groups`).get().c,
    lastTick: db.prepare(`SELECT * FROM tick_log ORDER BY id DESC LIMIT 1`).get() ?? null,
    daemons: db.prepare(`SELECT * FROM daemon_state ORDER BY name`).all(),
  };
}

async function cli() {
  const db = openDb();
  const status = collectStatus(db);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(formatStatus(status));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
