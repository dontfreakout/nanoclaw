/**
 * WhatsApp daemon: persistent process that
 *   - connects to WhatsApp via Baileys (reusing src/channels/whatsapp.ts)
 *   - stores inbound messages directly in sqlite (storeMessage + storeChatMetadata)
 *   - polls the `outbox` table for outbound messages addressed to whatsapp JIDs
 *     and sends them
 *   - exposes a tiny HTTP endpoint for health checks + on-demand send
 *
 * Run with: `npx tsx plugin/scripts/whatsapp-daemon.ts`
 * Spawned by `plugin/scripts/bootstrap.mjs`.
 */
import http from 'node:http';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import { WhatsAppChannel } from '../../src/channels/whatsapp.js';
import {
  initDatabase,
  storeMessage,
  storeChatMetadata,
  getAllRegisteredGroups,
} from '../../src/db.js';
import { logger } from '../../src/logger.js';
import type { NewMessage } from '../../src/types.js';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const PORT = Number(process.env.DAEMON_PORT || 9101);
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');

const outboxDb = new Database(DB_PATH);
outboxDb.pragma('journal_mode = WAL');

function claimOutboxRows(limit = 10) {
  const rows = outboxDb
    .prepare(
      `SELECT id, chat_jid, text FROM outbox
       WHERE status = 'pending'
         AND (chat_jid LIKE '%@g.us' OR chat_jid LIKE '%@s.whatsapp.net')
       ORDER BY created_at
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number; chat_jid: string; text: string }>;
  return rows;
}

function markDelivered(id: number) {
  outboxDb
    .prepare(
      `UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
}

function markFailed(id: number, error: string) {
  outboxDb
    .prepare(
      `UPDATE outbox
       SET status = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1,
           error = ?
       WHERE id = ?`,
    )
    .run(error, id);
}

async function main() {
  initDatabase();

  const channel = new WhatsAppChannel({
    onMessage: (chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
    },
    onChatMetadata: (jid, ts, name, ch, isGroup) =>
      storeChatMetadata(jid, ts, name, ch, isGroup),
    registeredGroups: () => getAllRegisteredGroups(),
  });

  await channel.connect();
  logger.info({ daemon: 'whatsapp' }, 'WhatsApp daemon connected');

  // Outbox poller
  const pollOutbox = async () => {
    try {
      const rows = claimOutboxRows();
      for (const row of rows) {
        try {
          await channel.sendMessage(row.chat_jid, row.text);
          markDelivered(row.id);
        } catch (err: any) {
          markFailed(row.id, String(err?.message || err));
        }
      }
    } catch (err) {
      logger.error({ err, daemon: 'whatsapp' }, 'outbox poll error');
    }
  };
  setInterval(pollOutbox, 1000);

  // HTTP endpoint for health + manual send
  const server = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, daemon: 'whatsapp' }));
      return;
    }
    if (req.url === '/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { chatJid, text } = JSON.parse(body);
          await channel.sendMessage(chatJid, text);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(PORT, '127.0.0.1');
  logger.info({ daemon: 'whatsapp', port: PORT }, 'daemon HTTP listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal, daemon: 'whatsapp' }, 'shutting down');
    server.close();
    await channel.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Update daemon_state heartbeat every 10s.
  setInterval(() => {
    try {
      outboxDb
        .prepare(
          `INSERT OR REPLACE INTO daemon_state (name, pid, port, status, started_at, error)
           VALUES ('whatsapp', ?, ?, 'running', COALESCE((SELECT started_at FROM daemon_state WHERE name = 'whatsapp'), ?), NULL)`,
        )
        .run(process.pid, PORT, new Date().toISOString());
    } catch {
      /* best effort */
    }
  }, 10_000);
}

main().catch((err) => {
  logger.fatal({ err }, 'whatsapp daemon crashed');
  process.exit(1);
});
