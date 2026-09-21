import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  uniqueNick,
  RawSocketClient,
  IRC_OPER,
  createRawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
} from '../helpers/index.js';

/**
 * Redaction catch-up on the linked bed (fork 2b98f1d, 2026-09-21; design B
 * of crdt-mesh-redact-catchup.md, tree half).
 *
 * A storage server that is split off while a REDACT propagates keeps and
 * re-serves the row.  Every store now keeps a time-ordered index of the
 * redactions it applied; when a store (re)advertises itself after a split
 * its peers ask it "redactions since my watermark" (CH Q * D) and apply
 * what they missed, idempotently.
 *
 * Linked bed: the primary and the leaf both store the channel (a member on
 * each).  The leaf is SQUIT, a row is redacted on the primary, the leaf is
 * reconnected: its CH A S re-advertisement triggers the catch-up.
 */

const CAPS = ['batch', 'server-time', 'message-tags', 'echo-message', 'draft/chathistory', 'draft/message-redaction'];
const SECONDARY_NAME = 'leaf.fractalrealities.net';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

/** How @a server's page sees the row (read by a fresh MEMBER: history is presence-filtered). */
async function pageView(server: { host: string; port: number }, chan: string, msgid: string, text: string): Promise<PageView> {
  const c = await client(server, uniqueNick('rcp'));
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

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 3000): Promise<T> {
  const t0 = Date.now();
  let last!: T;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`);
}

describe('redaction catch-up after a split (linked bed)', () => {
  const clients: RawSocketClient[] = [];
  const chan = `#rdc${Math.random().toString(36).slice(2, 7)}`;
  let speaker: RawSocketClient;
  let oper: RawSocketClient;
  const rows: { id: string; text: string }[] = [];

  beforeAll(async () => {
    const witness = await client(SECONDARY_SERVER, uniqueNick('rcw'));
    clients.push(witness);
    witness.send(`JOIN ${chan}`);
    await sleep(800);
    speaker = await client(PRIMARY_SERVER, uniqueNick('rcs'));
    clients.push(speaker);
    speaker.send(`JOIN ${chan}`);
    await sleep(1500);
    for (let i = 0; i < 2; i++) {
      const text = `row ${i} ${Math.random().toString(36).slice(2, 6)}`;
      rows.push({ id: await say(speaker, chan, text), text });
      await sleep(300);
    }
    await sleep(1500);
    oper = await client(PRIMARY_SERVER, uniqueNick('rco'));
    clients.push(oper);
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
  }, 60000);

  afterAll(async () => {
    try { oper.send(`CONNECT ${SECONDARY_NAME}`); await sleep(3000); } catch { /* */ }
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
  });

  it('the leaf stores the rows and sees a live redaction', async () => {
    expect(await pageView(SECONDARY_SERVER, chan, rows[0].id, rows[0].text)).toMatchObject({ contentVisible: true, redactRows: 0 });
    speaker.send(`REDACT ${chan} ${rows[0].id} :live`);
    const after = await until('leaf applies the live redaction', () => pageView(SECONDARY_SERVER, chan, rows[0].id, rows[0].text),
      v => !v.contentVisible && v.redactRows === 1, 20000, 2000);
    expect(after.redactRows).toBe(1);
  }, 60000);

  it('a leaf split off during a redaction catches up when it relinks', async () => {
    oper.send(`SQUIT ${SECONDARY_NAME} :redaction catch-up test`);
    await sleep(2500);
    speaker.send(`REDACT ${chan} ${rows[1].id} :while you were away`);
    await sleep(2000);
    /* the leaf still serves the row unredacted while split */
    expect(await pageView(SECONDARY_SERVER, chan, rows[1].id, rows[1].text)).toMatchObject({ contentVisible: true, redactRows: 0 });

    oper.send(`CONNECT ${SECONDARY_NAME}`);
    /* relink -> the leaf's CH A S re-advertisement -> both sides ask each
     * other for redactions since their watermark; the leaf applies ours. */
    const view = await until('leaf serves the row redacted after relink', () => pageView(SECONDARY_SERVER, chan, rows[1].id, rows[1].text),
      v => !v.contentVisible && v.redactRows === 1, 90000, 3000);
    expect(view.redactRows).toBe(1);
    /* and the one it saw live is still exactly one row (idempotent replay) */
    expect(await pageView(SECONDARY_SERVER, chan, rows[0].id, rows[0].text)).toMatchObject({ contentVisible: false, redactRows: 1 });
  }, 180000);
});
