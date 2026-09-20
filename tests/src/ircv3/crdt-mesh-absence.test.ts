import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { uniqueNick, RawSocketClient, IRC_OPER, createRawSocketClient } from '../helpers/index.js';

/**
 * Store absence on the CRDT mesh (crdt-mesh 862788c, 2026-09-20).
 *
 * On the tree bed (chathistory-partial.test.ts, chathistory-retention-
 * isupport.test.ts) a store's absence is bracketed by its SQUIT and its
 * next CH A S.  Among CRDT peers neither event means that: a SQUIT of a
 * mesh-reachable peer keeps it as a stub whose store is still queried
 * over the CR-X tunnel, and a peer that comes back through the mesh alone
 * never sends CH A S again.  There a store is absent while its CR H
 * beacon is stale, which only a node that is really gone produces -- so
 * this suite stops a container.
 *
 * Runs against the five-node CRDT fleet only (CRDT_BED=1, docker on the
 * host): hub2 (6669) is the origin, leaf4 (6673, container nefarious6) the
 * store that goes away.  Slow by nature: the beacon staleness window is
 * 90 s and the fleet's verify tick 30 s.
 */

const HUB2 = { host: 'localhost', port: 6669 };
const LEAF4 = { host: 'localhost', port: 6673 };
const LEAF4_CONTAINER = 'nefarious6';
const PARTIAL = 'evilnet.github.io/chathistory-partial';
const END = 'draft/chathistory-end';
const CAPS = ['batch', 'server-time', 'message-tags', 'draft/chathistory'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function client(server: { host: string; port: number }, nick: string, caps = CAPS): Promise<RawSocketClient> {
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs();
  if (caps.length) await c.capReq(caps);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

interface Page { partial: boolean; end: boolean; rows: number }

async function page(c: RawSocketClient, chan: string): Promise<Page> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY LATEST ${chan} * 20`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (c.allLines.slice(start).some(l => / BATCH -/.test(l))) break;
  }
  const lines = c.allLines.slice(start);
  const open = lines.find(l => / BATCH \+\S+ chathistory /.test(l));
  expect(open, `no chathistory batch:\n${lines.join('\n')}`).toBeTruthy();
  const tags = open!.startsWith('@') ? open!.split(' ', 1)[0].slice(1).split(';') : [];
  const id = / BATCH \+(\S+) /.exec(open!)![1];
  return {
    partial: tags.includes(PARTIAL),
    end: tags.includes(END),
    rows: lines.filter(l => l.includes(`batch=${id}`) && / PRIVMSG /.test(l)).length,
  };
}

/** The retention token a fresh client of @a server is told (seconds), or -1. */
async function retentionToken(server: { host: string; port: number }): Promise<number> {
  const c = await client(server, uniqueNick('ret'), []);
  const line = c.allLines.find(l => / 005 .*evilnet\/CHATHISTORYRETENTION=/.test(l));
  try { c.send('QUIT'); c.close(); } catch { /* */ }
  const m = line && /evilnet\/CHATHISTORYRETENTION=(\d+)/.exec(line);
  return m ? parseInt(m[1], 10) : -1;
}

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 15000): Promise<T> {
  const t0 = Date.now();
  let last!: T;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`);
}

const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString();

describe.skipIf(process.env.CRDT_BED !== '1')('store absence on the CRDT mesh', () => {
  const clients: RawSocketClient[] = [];
  const chan = `#mabs${Math.random().toString(36).slice(2, 7)}`;
  let reader: RawSocketClient;
  let leafOper: RawSocketClient;

  beforeAll(async () => {
    reader = await client(HUB2, uniqueNick('mar'));
    clients.push(reader);
    reader.send(`JOIN ${chan}`);
    await sleep(800);
    const speaker = await client(LEAF4, uniqueNick('mas'));
    clients.push(speaker);
    speaker.send(`JOIN ${chan}`);
    await sleep(800);
    for (let i = 0; i < 3; i++) { speaker.send(`PRIVMSG ${chan} :row ${i}`); await sleep(250); }
    await sleep(1500);
    leafOper = await client(LEAF4, uniqueNick('mao'), []);
    clients.push(leafOper);
    leafOper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await leafOper.waitForNumeric('381', 8000);
  }, 60000);

  afterAll(async () => {
    /* Whatever happened, leaf4 comes back and its retention is restored. */
    try { docker('start', LEAF4_CONTAINER); } catch { /* already running */ }
    try { leafOper.send('SET CHATHISTORY_RETENTION 7'); await sleep(300); } catch { /* the oper may be gone with leaf4 */ }
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
  });

  it('a stopped store makes pages partial; its return makes them complete again', async () => {
    const before = await page(reader, chan);
    expect(before, 'complete while every store is reachable').toMatchObject({ partial: false, end: true, rows: 3 });

    docker('stop', LEAF4_CONTAINER);
    try {
      const during = await until('partial while leaf4 is gone', () => page(reader, chan),
        p => p.partial && !p.end, 150000);
      expect(during.rows, 'the rows hub2 witnessed are still served').toBe(3);
    } finally {
      docker('start', LEAF4_CONTAINER);
    }
    const after = await until('complete once leaf4 beacons again', () => page(reader, chan),
      p => !p.partial && p.end, 300000);
    expect(after.rows).toBe(3);
  }, 600000);

  /** A fresh oper on leaf4 (the previous case restarted its container). */
  async function leaf4Oper(): Promise<RawSocketClient> {
    await until('leaf4 accepts clients', async () => {
      try { const c = await client(LEAF4, uniqueNick('mab'), []); c.send('QUIT'); c.close(); return true; } catch { return false; }
    }, v => v, 240000, 10000);
    const o = await client(LEAF4, uniqueNick('mao'), []);
    clients.push(o);
    o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await o.waitForNumeric('381', 8000);
    return o;
  }

  it('the retention token drops when the widest store leaves and rises when it is back', async () => {
    leafOper = await leaf4Oper();
    leafOper.send('SET CHATHISTORY_RETENTION 14');
    const wide = await until('hub2 learns leaf4 is the widest store', () => retentionToken(HUB2),
      s => s === 14 * 86400, 120000, 10000);
    expect(wide).toBe(14 * 86400);

    docker('stop', LEAF4_CONTAINER);
    try {
      const narrow = await until('token drops once leaf4 is absent', () => retentionToken(HUB2),
        s => s === 7 * 86400, 180000, 10000);
      expect(narrow).toBe(7 * 86400);
    } finally {
      docker('start', LEAF4_CONTAINER);
    }
    /* leaf4 boots with its conf value (7); set it wide again once it is
     * up so the rise is the store coming back, not the SET. */
    leafOper = await leaf4Oper();
    leafOper.send('SET CHATHISTORY_RETENTION 14');
    const back = await until('token rises once leaf4 beacons again', () => retentionToken(HUB2),
      s => s === 14 * 86400, 240000, 10000);
    expect(back).toBe(14 * 86400);
  }, 900000);
});
