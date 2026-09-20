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
 * Federated SEARCH (soju.im/search over the CHATHISTORY federation path,
 * 2026-09-20, docs/features/search.md "Storage peers"):
 *
 *   A channel's rows can live on more than one storage server.  A SEARCH
 *   with in=<channel> fans out to every storage server exactly as a page
 *   of the same window does (CH Q ... S ... :<selectors>), merges the
 *   replies by msgid and returns the newest `limit`.
 *
 * Linked bed: the primary and the leaf both store history, but only for
 * channels they have a member in.  Rows said while only the leaf had a
 * member exist on the leaf alone, so a search issued on the primary can
 * only find them by asking.
 */

const CAPS = ['soju.im/search', 'batch', 'server-time', 'message-tags', 'draft/chathistory'];
const SECONDARY_NAME = 'leaf.fractalrealities.net';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function searchRows(client: RawSocketClient, start: number): string[] | undefined {
  const lines = client.allLines.slice(start);
  const open = lines.find(l => / BATCH \+\S+ search\b/.test(l));
  if (!open) return undefined;
  const id = / BATCH \+(\S+) /.exec(open)![1];
  return lines.filter(l => l.includes(`batch=${id}`) && / (PRIVMSG|NOTICE) /.test(l));
}
const textOf = (row: string) => row.slice(row.lastIndexOf(' :') + 2);

async function client(server: { host: string; port: number }, nick: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs();
  await c.capReq(CAPS);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

async function search(c: RawSocketClient, selectors: string, waitMs = 3000): Promise<string[]> {
  const start = c.allLines.length;
  c.send(`SEARCH ${selectors}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const lines = c.allLines.slice(start);
    if (lines.some(l => / BATCH -/.test(l))) break;
  }
  const rows = searchRows(c, start);
  expect(rows, `no search batch:\n${c.allLines.slice(start).join('\n')}`).toBeTruthy();
  return rows!.map(textOf);
}

describe('SEARCH federation (linked bed)', () => {
  const clients: RawSocketClient[] = [];
  const chan = `#fsr${Math.random().toString(36).slice(2, 7)}`;
  let leafSpeaker: RawSocketClient;
  let primaryReader: RawSocketClient;
  const leafNick = uniqueNick('fsl');

  beforeAll(async () => {
    /* Rows that exist on the leaf only: the leaf's user speaks before any
     * primary user is in the channel, so the primary never witnessed
     * (and never stored) them. */
    leafSpeaker = await client(SECONDARY_SERVER, leafNick);
    clients.push(leafSpeaker);
    leafSpeaker.send(`JOIN ${chan}`);
    await sleep(800);
    for (const t of ['alpha one', 'alpha two', 'alpha three']) {
      leafSpeaker.send(`PRIVMSG ${chan} :${t}`);
      await sleep(250);
    }
    await sleep(1200);

    primaryReader = await client(PRIMARY_SERVER, uniqueNick('fsp'));
    clients.push(primaryReader);
    primaryReader.send(`JOIN ${chan}`);
    await sleep(800);
    /* A row both servers witnessed (both have a member now). */
    leafSpeaker.send(`PRIVMSG ${chan} :beta shared`);
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
  });

  it('finds rows that only the other storage server holds', async () => {
    const rows = await search(primaryReader, `in=${chan} text=alpha`);
    expect(rows).toEqual(['alpha one', 'alpha two', 'alpha three']);
  }, 30000);

  it('returns a row both servers hold exactly once, and honours from= and limit= across servers', async () => {
    expect(await search(primaryReader, `in=${chan} text=beta`)).toEqual(['beta shared']);
    expect(await search(primaryReader, `in=${chan} from=${leafNick} text=alpha limit=2`))
      .toEqual(['alpha two', 'alpha three']);
  }, 30000);

  it('a text with spaces survives the federation wire', async () => {
    /* A text with spaces is the trailing parameter, as the spec shows. */
    expect(await search(primaryReader, `in=${chan} :text=alpha t`)).toEqual(['alpha two', 'alpha three']);
  }, 30000);

  it('an oversize selector is refused before any fan-out', async () => {
    const start = primaryReader.allLines.length;
    primaryReader.send(`SEARCH in=${chan} text=${'x'.repeat(400)}`);
    await sleep(1000);
    expect(primaryReader.allLines.slice(start).some(l => / FAIL SEARCH INVALID_PARAMS /.test(l))).toBe(true);
  }, 15000);

  it('a storage server that is away still yields the local rows within the timeout', async () => {
    const oper = await client(PRIMARY_SERVER, uniqueNick('fso'));
    clients.push(oper);
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    oper.send(`SQUIT ${SECONDARY_NAME} :search federation test`);
    await sleep(2500);
    try {
      const t0 = Date.now();
      /* The primary holds only what it witnessed: the shared row. */
      const rows = await search(primaryReader, `in=${chan} text=a`, 9000);
      expect(rows).toEqual(['beta shared']);
      expect(Date.now() - t0, 'answered within the federation timeout').toBeLessThan(8000);
    } finally {
      oper.send(`CONNECT ${SECONDARY_NAME}`);
      await sleep(4000);
    }
  }, 40000);
});
