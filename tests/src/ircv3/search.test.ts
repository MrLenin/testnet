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
import { createTlsClient, tlsEnableHold, tlsDisableHold, type TlsClient } from '../helpers/tls-sasl-client.js';

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
/* Red until each evilnet/nefarious2 PR is merged and the bed's nefarious slot
 * is rebuilt: run with NEF_PR_<n>=1 then.  (An explicit gate, not a silent
 * skipIf.) */
const GATED_149 = process.env.NEF_PR_149 !== '1';
const GATED_150 = process.env.NEF_PR_150 !== '1';
const GATED_151 = process.env.NEF_PR_151 !== '1';
const GATED_152 = process.env.NEF_PR_152 !== '1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Batch {
  id: string;
  rows: string[];
}

/** The first `search` batch opened after `start` in the client's log, with its rows. */
function searchBatch(client: { allLines: string[] }, start: number): Batch | undefined {
  const lines = client.allLines.slice(start);
  /* `search` until evilnet/nefarious2 #152 lands, then `soju.im/search`
   * (drop the optional prefix then). */
  const open = lines.find(l => / BATCH \+\S+ (soju\.im\/)?search\b/.test(l));
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

const REDACT_CAPS = [...CAPS, 'echo-message', 'draft/message-redaction'];

/** Say a line and read its msgid from the echo. */
async function say(c: RawSocketClient, chan: string, text: string): Promise<string> {
  const start = c.allLines.length;
  c.send(`PRIVMSG ${chan} :${text}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(100);
    const echo = c.allLines.slice(start).find(l => / PRIVMSG /.test(l) && l.includes(text));
    const id = echo && /(?:^@|;)msgid=([^; ]+)/.exec(echo)?.[1];
    if (id) return id;
  }
  throw new Error(`no echo with a msgid for "${text}"`);
}

/** The lines from `start` up to the close of the first search batch opened
 * after it, once that batch has closed; throws if it doesn't close in time. */
async function searchLines(c: RawSocketClient, start: number, what: string, ms = 5000): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(150);
    const lines = c.allLines.slice(start);
    const open = lines.find(l => / BATCH \+\S+ (soju\.im\/)?search\b/.test(l));
    const id = open && / BATCH \+(\S+) /.exec(open)?.[1];
    const end = id ? lines.findIndex(l => / BATCH -(\S+)/.exec(l)?.[1] === id) : -1;
    if (end >= 0) return lines.slice(0, end + 1);
  }
  throw new Error(`no closed search batch for ${what}:\n${c.allLines.slice(start).join('\n')}`);
}

/** Send a SEARCH and return its batch once it closes. */
async function runSearch(c: RawSocketClient, args: string): Promise<Batch> {
  const start = c.allLines.length;
  c.send(`SEARCH ${args}`);
  await searchLines(c, start, args);
  return searchBatch(c, start)!;
}

const uniq = () => Math.random().toString(36).slice(2, 8);

describe('#149 SEARCH: redacted rows', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const channel = `#srd${uniq()}`;
  let a: RawSocketClient;
  let b: RawSocketClient;

  beforeAll(async () => {
    if (GATED_149) return;
    for (const tag of ['rda', 'rdb']) {
      const acc = await getTestAccount();
      if (acc.fromPool) pool.push(acc.account);
      const r = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick(tag), extraCaps: REDACT_CAPS });
      clients.push(r.client);
      r.client.send(`JOIN ${channel}`);
    }
    [a, b] = clients;
    await sleep(800);
  }, 60000);

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    for (const p of pool) releaseTestAccount(p);
  });

  it.skipIf(GATED_149)('a redacted line is hidden with in= and without it', async () => {
    const word = `hide${uniq()}`;
    const id = await say(a, channel, `${word} gone`);
    await say(a, channel, `${word} kept`);
    a.send(`REDACT ${channel} ${id}`);
    await sleep(1000);
    expect((await runSearch(a, `in=${channel} text=${word}`)).rows.map(textOf)).toEqual([`${word} kept`]);
    expect((await runSearch(a, `text=${word}`)).rows.map(textOf)).toEqual([`${word} kept`]);
  }, 30000);

  it.skipIf(GATED_149)('five matches with the newest two redacted and limit=2 returns 2', async () => {
    const word = `five${uniq()}`;
    const ids: string[] = [];
    for (const n of ['one', 'two', 'three', 'four', 'five']) {
      ids.push(await say(a, channel, `${word} ${n}`));
      await sleep(100);
    }
    a.send(`REDACT ${channel} ${ids[3]}`);
    a.send(`REDACT ${channel} ${ids[4]}`);
    await sleep(1000);
    expect((await runSearch(a, `in=${channel} text=${word} limit=2`)).rows.map(textOf))
      .toEqual([`${word} two`, `${word} three`]);
  }, 30000);

  it.skipIf(GATED_149)('a line with a reply or a reaction stays findable', async () => {
    const word = `kids${uniq()}`;
    const replied = await say(a, channel, `${word} replied to`);
    const reacted = await say(a, channel, `${word} reacted to`);
    const at = a.allLines.length;
    b.send(`@+draft/reply=${replied} PRIVMSG ${channel} :a reply`);
    b.send(`@+draft/reply=${reacted};+draft/react=ok TAGMSG ${channel}`);
    /* Both must reach the channel with their parent's msgid, or the parents
     * are just plain lines and this proves nothing. */
    const deadline = Date.now() + 5000;
    const got = () => a.allLines.slice(at);
    const hasReply = () => got().some(l => l.includes(`+draft/reply=${replied}`) && / PRIVMSG /.test(l));
    const hasReact = () => got().some(l => l.includes(`+draft/reply=${reacted}`) && / TAGMSG /.test(l));
    while (Date.now() < deadline && !(hasReply() && hasReact())) await sleep(100);
    expect(hasReply(), `the reply reached the channel:\n${got().join('\n')}`).toBe(true);
    expect(hasReact(), `the reaction reached the channel:\n${got().join('\n')}`).toBe(true);
    await sleep(500);
    expect((await runSearch(a, `in=${channel} text=${word}`)).rows.map(textOf))
      .toEqual([`${word} replied to`, `${word} reacted to`]);
  }, 30000);
});

describe('#150 SEARCH: a plaintext alias with no in=', () => {
  let primary: TlsClient | undefined;
  let device: RawSocketClient | undefined;
  let account = '';
  let fromPool = false;

  afterAll(async () => {
    try { if (primary) await tlsDisableHold(primary); } catch { /* */ }
    for (const c of [device, primary]) { try { c?.send('QUIT'); c?.close(); } catch { /* */ } }
    if (fromPool) releaseTestAccount(account);
  });

  it.skipIf(GATED_150)("finds the primary's channels except the +Z one", async () => {
    const word = `alias${uniq()}`;
    const open = `#sao${uniq()}`;
    const secure = `#saz${uniq()}`;
    const acc = await getTestAccount();
    account = acc.account;
    fromPool = acc.fromPool;
    primary = await createTlsClient(uniqueNick('sap'), { account: acc.account, password: acc.password, caps: CAPS });
    await tlsEnableHold(primary);
    primary.send(`JOIN ${open}`);
    primary.send(`JOIN ${secure}`);
    await sleep(800);
    const modeAt = primary.lines.length;
    primary.send(`MODE ${secure} +Z`);
    await primary.waitFor(/ MODE \S+ \+Z/, modeAt, 5000);
    primary.send(`PRIVMSG ${open} :${word} open`);
    primary.send(`PRIVMSG ${secure} :${word} secure`);
    await sleep(1200);

    /* Control: the +Z row is there to find, for the TLS primary. */
    const from = primary.lines.length;
    primary.send(`SEARCH text=${word}`);
    await primary.waitFor(/ BATCH -/, from, 5000);
    const primaryRows = primary.lines.slice(from).filter(l => / PRIVMSG /.test(l)).map(textOf).sort();
    expect(primaryRows).toEqual([`${word} open`, `${word} secure`]);

    const r = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('sad'), extraCaps: CAPS });
    device = r.client;
    await sleep(1000);
    expect((await runSearch(device, `text=${word}`)).rows.map(textOf)).toEqual([`${word} open`]);
  }, 60000);
});

describe('#151 SEARCH: case folds in UTF-8', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const channel = `#scf${uniq()}`;

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    for (const p of pool) releaseTestAccount(p);
  });

  it.skipIf(GATED_151)('Cyrillic and Latin-1 match in either case, and an ASCII needle reads past high bytes', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const { client: a } = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('scf'), extraCaps: REDACT_CAPS });
    clients.push(a);
    a.send(`JOIN ${channel}`);
    await sleep(800);
    await say(a, channel, 'ПРИВЕТ Мир');
    await say(a, channel, 'CAFÉ crème');
    await say(a, channel, 'Привет xylo');
    await sleep(800);
    expect((await runSearch(a, `in=${channel} text=привет`)).rows.map(textOf)).toEqual(['ПРИВЕТ Мир', 'Привет xylo']);
    expect((await runSearch(a, `in=${channel} text=café`)).rows.map(textOf)).toEqual(['CAFÉ crème']);
    expect((await runSearch(a, `in=${channel} text=CRÈME`)).rows.map(textOf)).toEqual(['CAFÉ crème']);
    expect((await runSearch(a, `in=${channel} text=XYLO`)).rows.map(textOf)).toEqual(['Привет xylo']);
  }, 30000);
});

describe('#152 SEARCH: the soju form and its batch', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const channel = `#ssj${uniq()}`;
  let a: RawSocketClient;

  beforeAll(async () => {
    if (GATED_152) return;
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    ({ client: a } = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('ssj'), extraCaps: [...REDACT_CAPS, 'labeled-response'] }));
    clients.push(a);
    a.send(`JOIN ${channel}`);
    await sleep(800);
    await say(a, channel, 'alpha one');
    await say(a, channel, 'beta;two');
    await sleep(800);
  }, 60000);

  afterAll(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    for (const p of pool) releaseTestAccount(p);
  });

  it.skipIf(GATED_152)('reads one parameter with \\s and \\: escapes', async () => {
    expect((await runSearch(a, `in=${channel};text=alpha\\sone`)).rows.map(textOf)).toEqual(['alpha one']);
    expect((await runSearch(a, `in=${channel};text=beta\\:two`)).rows.map(textOf)).toEqual(['beta;two']);
  }, 30000);

  it.skipIf(GATED_152)('text=a;text= searches with no text filter: the last value wins, empty too', async () => {
    const rows = (await runSearch(a, `in=${channel};text=nothingsaidthis;text=`)).rows.map(textOf);
    expect(rows).toEqual(['alpha one', 'beta;two']);
  }, 30000);

  it.skipIf(GATED_152)('a labeled SEARCH gets one labeled soju.im/search batch and no ACK', async () => {
    const start = a.allLines.length;
    a.send(`@label=srch1 SEARCH in=${channel};text=alpha`);
    const lines = await searchLines(a, start, 'labeled');
    await sleep(500);   // room for a stray ACK after the batch
    lines.push(...a.allLines.slice(start + lines.length));
    const labeled = lines.filter(l => /(^@|;)label=srch1\b/.test(l));
    expect(labeled, lines.join('\n')).toHaveLength(1);
    expect(labeled[0]).toMatch(/ BATCH \+\S+ soju\.im\/search\b/);
    expect(lines.some(l => / ACK\b/.test(l)), lines.join('\n')).toBe(false);
  }, 30000);

  it.skipIf(GATED_152)('an unlabeled SEARCH has no @label=', async () => {
    const start = a.allLines.length;
    a.send(`SEARCH in=${channel};text=alpha`);
    const lines = await searchLines(a, start, 'unlabeled');
    expect(lines.some(l => /(^@|;)label=/.test(l)), lines.join('\n')).toBe(false);
  }, 30000);
});
