import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  uniqueNick,
  RawSocketClient,
  IRC_OPER,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  createRawSocketClient,
} from '../helpers/index.js';

/**
 * soju.im/search (https://codeberg.org/emersion/soju/src/branch/master/doc/ext/search.md):
 *
 *   SEARCH in=<target> [from=<nick>] [text=<words>] [after=<ts>] [before=<ts>] [limit=<n>]
 *
 * answered with a batch of type `search` holding the matching PRIVMSG /
 * NOTICE rows in ascending time order, each with msgid and time tags, or
 * an empty batch; malformed selectors get `FAIL SEARCH INVALID_PARAMS`.
 *
 * Ours (2026-09-20, Rubin's request): a brute scan of the store from
 * `before` (default now) back to `after`, the newest `limit` matches;
 * `text` is a case-insensitive substring; results pass the same presence
 * filter as CHATHISTORY, so a member who was not there does not find it.
 */

const CAPS = ['soju.im/search', 'batch', 'server-time', 'message-tags', 'draft/chathistory'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Batch {
  id: string;
  rows: string[];
}

/** The first `search` batch opened after `start` in the client's log, with its rows. */
function searchBatch(client: { allLines: string[] }, start: number): Batch | undefined {
  const lines = client.allLines.slice(start);
  const open = lines.find(l => / BATCH \+\S+ search\b/.test(l));
  if (!open) return undefined;
  const id = / BATCH \+(\S+) /.exec(open)![1];
  const rows = lines.filter(l => l.includes(`batch=${id}`) && / (PRIVMSG|NOTICE) /.test(l));
  return { id, rows };
}

const textOf = (row: string) => row.slice(row.lastIndexOf(' :') + 2);

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('srop'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

describe('SEARCH (soju.im/search)', () => {
  const clients: { send: (l: string) => void; close: () => void }[] = [];
  const pool: string[] = [];
  const channel = `#srch${Math.random().toString(36).slice(2, 7)}`;
  let a: Awaited<ReturnType<typeof createSaslBouncerClient>>;
  let b: Awaited<ReturnType<typeof createSaslBouncerClient>>;
  let beforeSeed = '';
  let midSeed = '';

  beforeAll(async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const acc2 = await getTestAccount();
    if (acc2.fromPool) pool.push(acc2.account);
    a = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('sra'), extraCaps: CAPS });
    clients.push(a.client);
    b = await createSaslBouncerClient(acc2.account, acc2.password, { nick: uniqueNick('srb'), extraCaps: CAPS });
    clients.push(b.client);
    a.client.send(`JOIN ${channel}`);
    b.client.send(`JOIN ${channel}`);
    await sleep(800);
    beforeSeed = new Date().toISOString();
    a.client.send(`PRIVMSG ${channel} :alpha one`);
    await sleep(250);
    a.client.send(`PRIVMSG ${channel} :beta two`);
    await sleep(250);
    midSeed = new Date().toISOString();
    await sleep(250);
    b.client.send(`PRIVMSG ${channel} :Alpha from b`);
    await sleep(250);
    a.client.send(`NOTICE ${channel} :alpha as a notice`);
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    for (const p of pool) releaseTestAccount(p);
  });

  it('text= finds the matches, ascending, in a search batch with msgid and time tags', async () => {
    const start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} text=alpha`);
    await sleep(2500);
    const batch = searchBatch(a.client, start);
    expect(batch, `no search batch:\n${a.client.allLines.slice(start).join('\n')}`).toBeTruthy();
    expect(batch!.rows.map(textOf)).toEqual(['alpha one', 'Alpha from b', 'alpha as a notice']);
    for (const row of batch!.rows) {
      expect(row, 'msgid tag').toMatch(/(^@|;)msgid=/);
      expect(row, 'time tag').toMatch(/(^@|;)time=/);
    }
    expect(batch!.rows.some(r => / NOTICE /.test(r)), 'notices are searched too').toBe(true);
  }, 30000);

  it('from= narrows to one sender; the match is case-insensitive', async () => {
    const start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} from=${b.nick} text=ALPHA`);
    await sleep(2500);
    const batch = searchBatch(a.client, start);
    expect(batch).toBeTruthy();
    expect(batch!.rows.map(textOf)).toEqual(['Alpha from b']);
  }, 30000);

  it('limit= keeps the newest matches; after=/before= bound the window', async () => {
    let start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} text=alpha limit=1`);
    await sleep(2500);
    let batch = searchBatch(a.client, start);
    expect(batch!.rows.map(textOf), 'the newest match').toEqual(['alpha as a notice']);

    start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} text=alpha before=${midSeed}`);
    await sleep(2500);
    batch = searchBatch(a.client, start);
    expect(batch!.rows.map(textOf), 'before= excludes later rows').toEqual(['alpha one']);

    start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} text=alpha after=${midSeed}`);
    await sleep(2500);
    batch = searchBatch(a.client, start);
    expect(batch!.rows.map(textOf), 'after= excludes earlier rows').toEqual(['Alpha from b', 'alpha as a notice']);
  }, 60000);

  it('no match is an empty batch, not a FAIL or a timeout', async () => {
    const start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} text=nothingsaidthis`);
    await sleep(2500);
    const batch = searchBatch(a.client, start);
    expect(batch, 'an empty batch was expected').toBeTruthy();
    expect(batch!.rows).toEqual([]);
    expect(a.client.allLines.slice(start).some(l => / FAIL SEARCH /.test(l))).toBe(false);
  }, 30000);

  it('a bad timestamp or an inaccessible target is FAIL SEARCH INVALID_PARAMS', async () => {
    let start = a.client.allLines.length;
    a.client.send(`SEARCH in=${channel} after=yesterday`);
    await sleep(1500);
    expect(a.client.allLines.slice(start).some(l => / FAIL SEARCH INVALID_PARAMS /.test(l)),
      a.client.allLines.slice(start).join('\n')).toBe(true);

    start = a.client.allLines.length;
    a.client.send(`SEARCH in=#srch-not-joined-${uniqueNick('x')} text=alpha`);
    await sleep(1500);
    expect(a.client.allLines.slice(start).some(l => / FAIL SEARCH INVALID_PARAMS /.test(l)),
      a.client.allLines.slice(start).join('\n')).toBe(true);
  }, 30000);

  it('without the capability SEARCH is an unknown command', async () => {
    const plain = await createRawSocketClient();
    clients.push(plain);
    await plain.capLs();
    plain.capEnd();
    plain.register(uniqueNick('srp'));
    await plain.waitForNumeric('001');
    plain.send(`SEARCH in=${channel} text=alpha`);
    await plain.waitForNumeric('421', 5000);
  }, 30000);

  describe('under strict presence', () => {
    let oper: RawSocketClient;

    beforeAll(async () => {
      oper = await createOperClient();
      clients.push(oper);
      oper.send('SET CHATHISTORY_STRICT_PRESENCE TRUE');
      await sleep(300);
    }, 30000);

    afterAll(async () => {
      oper.send('SET CHATHISTORY_STRICT_PRESENCE FALSE');
      await sleep(300);
    });

    it('a member who joined after the messages does not find them', async () => {
      const acc = await getTestAccount();
      if (acc.fromPool) pool.push(acc.account);
      const late = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('src'), extraCaps: CAPS });
      clients.push(late.client);
      late.client.send(`JOIN ${channel}`);
      await sleep(800);
      late.client.send(`PRIVMSG ${channel} :alpha after joining`);
      await sleep(1200);

      const start = late.client.allLines.length;
      late.client.send(`SEARCH in=${channel} text=alpha`);
      await sleep(2500);
      const batch = searchBatch(late.client, start);
      expect(batch, 'a batch was expected').toBeTruthy();
      expect(batch!.rows.map(textOf), 'only what was said while present').toEqual(['alpha after joining']);
    }, 60000);
  });
});
