import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  uniqueNick,
  RawSocketClient,
  IRC_OPER,
  createRawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
} from '../helpers/index.js';
import { getP10Logs } from '../helpers/p10-protocol.js';

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
/* Red until each evilnet/nefarious2 PR is merged and the bed's nefarious slots
 * are rebuilt: run with NEF_PR_<n>=1 then.  (An explicit gate, not a silent
 * skipIf.) */
const GATED_149 = process.env.NEF_PR_149 !== '1';
const GATED_152 = process.env.NEF_PR_152 !== '1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function searchRows(client: RawSocketClient, start: number): string[] | undefined {
  const lines = client.allLines.slice(start);
  /* `search` until evilnet/nefarious2 #152 lands, then `soju.im/search`
   * (drop the optional prefix then). */
  const open = lines.find(l => / BATCH \+\S+ (soju\.im\/)?search\b/.test(l));
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

describe('#149 SEARCH federation: redacted rows', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const chan = `#frd${Math.random().toString(36).slice(2, 7)}`;

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    for (const p of pool) releaseTestAccount(p);
  });

  it.skipIf(GATED_149)('a row redacted on the leaf does not come back to a search from the primary', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const { client: leaf } = await createSaslBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('frl'),
      host: SECONDARY_SERVER.host,
      port: SECONDARY_SERVER.port,
      extraCaps: [...CAPS, 'echo-message', 'draft/message-redaction'],
    });
    clients.push(leaf);
    leaf.send(`JOIN ${chan}`);
    await sleep(800);

    const say = async (text: string): Promise<string> => {
      const start = leaf.allLines.length;
      leaf.send(`PRIVMSG ${chan} :${text}`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(100);
        const id = /(?:^@|;)msgid=([^; ]+)/.exec(
          leaf.allLines.slice(start).find(l => / PRIVMSG /.test(l) && l.includes(text)) ?? '')?.[1];
        if (id) return id;
      }
      throw new Error(`no echo with a msgid for "${text}"`);
    };

    /* Two rows only the leaf holds, then one both servers hold. */
    const leafOnly = await say('rdf leaf gone');
    await say('rdf leaf kept');
    await sleep(800);
    const reader = await client(PRIMARY_SERVER, uniqueNick('frp'));
    clients.push(reader);
    reader.send(`JOIN ${chan}`);
    await sleep(800);
    const shared = await say('rdf shared gone');
    await sleep(1000);

    leaf.send(`REDACT ${chan} ${leafOnly}`);
    leaf.send(`REDACT ${chan} ${shared}`);
    await sleep(1500);
    expect(await search(reader, `in=${chan} text=rdf`)).toEqual(['rdf leaf kept']);
  }, 60000);
});

describe('#152 SEARCH federation: line breaks stay off the wire', () => {
  const clients: RawSocketClient[] = [];
  const chan = `#fcr${Math.random().toString(36).slice(2, 7)}`;

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
  });

  it.skipIf(GATED_152)('text=a\\nb is refused with FAIL, and nothing goes out over CH Q', async () => {
    const c = await client(PRIMARY_SERVER, uniqueNick('fcr'));
    clients.push(c);
    c.send(`JOIN ${chan}`);
    await sleep(800);
    /* A member on the leaf makes it a storage peer a search would ask. */
    const leaf = await client(SECONDARY_SERVER, uniqueNick('fcl'));
    clients.push(leaf);
    leaf.send(`JOIN ${chan}`);
    await sleep(1200);

    const start = c.allLines.length;
    c.send(`SEARCH in=${chan};text=a\\nb`);
    await sleep(1500);
    const lines = c.allLines.slice(start);
    expect(lines.some(l => / FAIL SEARCH INVALID_PARAMS /.test(l)), lines.join('\n')).toBe(true);
    expect(lines.some(l => / BATCH /.test(l)), lines.join('\n')).toBe(false);
    /* The bed's debug log shows what was sent to a server.  getP10Logs gives
     * [] when the log can't be read, so a valid search must show up there
     * first, or "no CH Q" proves nothing. */
    const fanOut = new RegExp(`CH Q .*${chan.slice(1)}.*text=`);
    const before = await getP10Logs('nefarious', fanOut, '30s');
    expect(before, before.join('\n')).toEqual([]);
    await search(c, `in=${chan} text=control`);
    await sleep(500);
    const control = await getP10Logs('nefarious', fanOut, '30s');
    expect(control.length, 'a valid search fans out a CH Q the log can see').toBeGreaterThan(0);
  }, 30000);
});
