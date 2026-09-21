import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { uniqueNick, RawSocketClient, createRawSocketClient } from '../helpers/index.js';

/**
 * REDACT on the CRDT mesh (design B, crdt-mesh e6bdbf9, 2026-09-21).
 *
 * Live half: a redaction floods over the mesh (CR M 'R') and every store
 * applies it.  Durable half: a store that was ABSENT when the redaction
 * happened asks a reachable store for "redactions since my watermark" the
 * moment it is back (CH Q * D), and applies what it missed.  Nothing about
 * a redaction lives in the doc.
 *
 * Runs against the five-node CRDT fleet only (CRDT_BED=1, docker on the
 * host): hub2 (6669) is the origin, leaf4 (6673, container nefarious6) the
 * store that goes away.
 */

const HUB2 = { host: 'localhost', port: 6669 };
const LEAF4 = { host: 'localhost', port: 6673 };
const LEAF4_CONTAINER = 'nefarious6';
const CAPS = ['batch', 'server-time', 'message-tags', 'echo-message', 'draft/chathistory', 'draft/message-redaction'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString();

async function client(server: { host: string; port: number }, nick: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs();
  await c.capReq(CAPS);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

function tag(line: string, name: string): string | undefined {
  if (!line.startsWith('@')) return undefined;
  for (const kv of line.slice(1).split(' ', 1)[0].split(';')) {
    if (kv.startsWith(name + '=')) return kv.slice(name.length + 1);
  }
  return undefined;
}

/** Say a line and return the msgid the echo carried. */
async function say(c: RawSocketClient, chan: string, text: string): Promise<string> {
  const start = c.allLines.length;
  c.send(`PRIVMSG ${chan} :${text}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(100);
    const echo = c.allLines.slice(start).find(l => / PRIVMSG /.test(l) && l.includes(text));
    if (echo) {
      const id = tag(echo, 'msgid');
      expect(id, `echo carries a msgid:\n${echo}`).toBeTruthy();
      return id!;
    }
  }
  throw new Error(`no echo for "${text}"`);
}

interface PageView { contentVisible: boolean; redactRows: number }

/** How @a server's page sees the row @a msgid with @a text (read by a fresh member). */
async function pageView(server: { host: string; port: number }, chan: string, msgid: string, text: string): Promise<PageView> {
  /* A member reads: history is presence-filtered, a stranger sees nothing. */
  const c = await client(server, uniqueNick('mrp'));
  try {
    c.send(`JOIN ${chan}`);
    await sleep(700);
    const start = c.allLines.length;
    c.send(`CHATHISTORY LATEST ${chan} * 30`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(150);
      if (c.allLines.slice(start).some(l => / BATCH -/.test(l))) break;
    }
    const lines = c.allLines.slice(start);
    return {
      contentVisible: lines.some(l => / PRIVMSG /.test(l) && l.includes(text)),
      redactRows: lines.filter(l => / REDACT /.test(l) && l.includes(msgid)).length,
    };
  } finally {
    try { c.send('QUIT'); c.close(); } catch { /* */ }
  }
}

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 5000): Promise<T> {
  const t0 = Date.now();
  let last!: T;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`);
}

describe.skipIf(process.env.CRDT_BED !== '1')('REDACT on the CRDT mesh', () => {
  const clients: RawSocketClient[] = [];
  const chan = `#mrd${Math.random().toString(36).slice(2, 7)}`;
  let speaker: RawSocketClient;
  const rows: { id: string; text: string }[] = [];

  beforeAll(async () => {
    /* leaf4 gets a member first so it stores the channel; hub2 speaks. */
    const witness = await client(LEAF4, uniqueNick('mrw'));
    clients.push(witness);
    witness.send(`JOIN ${chan}`);
    await sleep(800);
    speaker = await client(HUB2, uniqueNick('mrs'));
    clients.push(speaker);
    speaker.send(`JOIN ${chan}`);
    await sleep(1500);
    for (let i = 0; i < 3; i++) {
      const text = `row ${i} ${Math.random().toString(36).slice(2, 6)}`;
      rows.push({ id: await say(speaker, chan, text), text });
      await sleep(300);
    }
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    try { docker('start', LEAF4_CONTAINER); } catch { /* already running */ }
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
  });

  it('a live redaction reaches the other store: content gone, one context row', async () => {
    const before = await pageView(LEAF4, chan, rows[0].id, rows[0].text);
    expect(before).toMatchObject({ contentVisible: true, redactRows: 0 });

    speaker.send(`REDACT ${chan} ${rows[0].id} :live`);
    const after = await until('leaf4 applies the live redaction', () => pageView(LEAF4, chan, rows[0].id, rows[0].text),
      v => !v.contentVisible && v.redactRows === 1, 20000, 2000);
    expect(after.redactRows).toBe(1);
  }, 60000);

  it('a store that was down during a redaction catches up when it is back', async () => {
    docker('stop', LEAF4_CONTAINER);
    await sleep(2000);
    const startedAt = new Date().toISOString();
    speaker.send(`REDACT ${chan} ${rows[1].id} :while you were away`);
    await sleep(3000);
    docker('start', LEAF4_CONTAINER);

    /* leaf4 boots, sees hub2 (a store) reachable for the first time and
     * asks it for redactions since its watermark. */
    const applied = await until('leaf4 logs the catch-up', async () => {
      try {
        const log = docker('logs', '--since', startedAt, LEAF4_CONTAINER);
        return /REDACT catch-up from \w+: applied (\d+) redaction/.exec(log)?.[1] ?? '';
      } catch { return ''; }
    }, v => v !== '' && parseInt(v, 10) >= 1, 300000, 5000);
    expect(parseInt(applied, 10)).toBeGreaterThanOrEqual(1);

    const view = await until('leaf4 serves the row redacted', () => pageView(LEAF4, chan, rows[1].id, rows[1].text),
      v => !v.contentVisible && v.redactRows === 1, 60000, 3000);
    expect(view.redactRows).toBe(1);

    /* the redaction it did see live is untouched: still exactly one row */
    const first = await pageView(LEAF4, chan, rows[0].id, rows[0].text);
    expect(first).toMatchObject({ contentVisible: false, redactRows: 1 });
  }, 600000);
});
