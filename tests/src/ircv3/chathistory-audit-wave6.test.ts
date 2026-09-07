/**
 * Chathistory audit, wave 6: the behaviours the coverage map found
 * uncovered (2026-09-06).  Single file, one connection set per case.
 *
 *  1. AROUND returns rows on BOTH sides of the pivot, by msgid and by
 *     timestamp, and includes the pivot row itself.
 *  2. Unknown / malformed msgid references never hang or crash: BEFORE,
 *     AFTER, AROUND and BETWEEN answer with a batch or a FAIL.
 *  3. Multiline inside a chathistory reply: a draft/multiline client gets
 *     a nested multiline batch with the msgid on its opener only; a
 *     client without multiline gets the lines as separate PRIVMSGs with
 *     the msgid on the first only (one msgid per event).
 *  4. REDACT through history: with draft/message-redaction the REDACT row
 *     is delivered and the original is not; without it the original is
 *     dropped and no REDACT line reaches the client.
 *  5. Bouncer auto-replay honours its limit: more rows than the limit
 *     replays exactly the newest `limit` with NO end tag; fewer replays
 *     them all WITH the end tag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  createRawSocketClient,
  PRIMARY_SERVER,
  uniqueChannel,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  createSaslBouncerClient,
  disconnectAbruptly,
  reconnectBouncer,
} from '../helpers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BASE = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];

interface Reply { lines: string[]; opener: string; endTag: boolean; failed: string | null; }

async function query(c: RawSocketClient, cmd: string, timeout = 8000): Promise<Reply> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY ${cmd}`);
  await c.waitForLine(/BATCH -|FAIL CHATHISTORY/, timeout);
  const lines = c.allLines.slice(start);
  const opener = lines.find(l => /BATCH \+/.test(l)) ?? '';
  const fail = lines.find(l => /FAIL CHATHISTORY/.test(l)) ?? null;
  return { lines, opener, endTag: /draft\/chathistory-end/.test(opener), failed: fail };
}
const texts = (r: Reply) => r.lines.filter(l => /^@[^ ]*batch=/.test(l) && / PRIVMSG /.test(l)).map(l => l.replace(/^.* PRIVMSG \S+ :/, ''));
const msgidOf = (l: string) => /msgid=([^;\s]+)/.exec(l)?.[1] ?? '';
const timeOf = (l: string) => /(?:^@|;)time=([^;\s]+)/.exec(l)?.[1] ?? '';

async function connect(caps: string[], prefix: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs(); await c.capReq(caps); c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  return c;
}

describe('chathistory audit wave 6', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const track = (c: RawSocketClient) => { clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('AROUND returns rows on both sides of the pivot and the pivot itself', async () => {
    const c = track(await connect(BASE, 'ar'));
    const chan = uniqueChannel('around');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    for (let i = 0; i < 9; i++) { c.send(`PRIVMSG ${chan} :m${i}`); await sleep(40); }
    await sleep(1200);
    const all = (await query(c, `LATEST ${chan} * 20`)).lines.filter(l => / PRIVMSG /.test(l) && /batch=/.test(l));
    const m4 = all.find(l => l.endsWith(':m4'))!;
    expect(m4, 'm4 stored').toBeTruthy();

    const byId = await query(c, `AROUND ${chan} msgid=${msgidOf(m4)} 5`);
    const t1 = texts(byId);
    expect(t1, 'pivot included').toContain('m4');
    expect(t1.some(t => ['m2', 'm3'].includes(t)), 'rows before the pivot').toBe(true);
    expect(t1.some(t => ['m5', 'm6'].includes(t)), 'rows after the pivot').toBe(true);
    expect(t1.length).toBeLessThanOrEqual(5);

    const byTime = await query(c, `AROUND ${chan} timestamp=${timeOf(m4)} 5`);
    const t2 = texts(byTime);
    expect(t2, 'the row AT the timestamp is included').toContain('m4');
    expect(t2.some(t => ['m2', 'm3'].includes(t)), 'rows before').toBe(true);
    expect(t2.some(t => ['m5', 'm6'].includes(t)), 'rows after').toBe(true);
  });

  it('unknown and malformed msgid references answer with a batch or a FAIL, never a hang', async () => {
    const c = track(await connect(BASE, 'bad'));
    const chan = uniqueChannel('badref');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    c.send(`PRIVMSG ${chan} :one`); await sleep(800);
    const refs = ['msgid=doesnotexist', 'msgid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'msgid=%%%', 'msgid='];
    for (const ref of refs) {
      for (const sub of ['BEFORE', 'AFTER', 'AROUND']) {
        const r = await query(c, `${sub} ${chan} ${ref} 10`);
        expect(r.failed !== null || r.opener !== '', `${sub} ${ref}: batch or FAIL`).toBe(true);
      }
      const b = await query(c, `BETWEEN ${chan} ${ref} timestamp=${new Date().toISOString()} 10`);
      expect(b.failed !== null || b.opener !== '', `BETWEEN ${ref}: batch or FAIL`).toBe(true);
    }
    // The connection is still alive and serving.
    const ok = await query(c, `LATEST ${chan} * 5`);
    expect(texts(ok)).toContain('one');
  });

  it('multiline in history: nested batch with msgid on the opener, or lines with msgid on the first only', async () => {
    const sender = track(await connect([...BASE, 'draft/multiline'], 'mls'));
    const chan = uniqueChannel('mlhist');
    sender.send(`JOIN ${chan}`); await sender.waitForJoin(chan);
    sender.send(`BATCH +ml1 draft/multiline ${chan}`);
    sender.send(`@batch=ml1 PRIVMSG ${chan} :line one`);
    sender.send(`@batch=ml1 PRIVMSG ${chan} :line two`);
    sender.send(`@batch=ml1 PRIVMSG ${chan} :line three`);
    sender.send('BATCH -ml1');
    await sleep(1500);

    // Tier 1: a multiline client gets a nested draft/multiline batch.
    const t1 = track(await connect([...BASE, 'draft/multiline'], 'ml1'));
    t1.send(`JOIN ${chan}`); await t1.waitForJoin(chan);
    const r1 = await query(t1, `LATEST ${chan} * 10`);
    const nested = r1.lines.find(l => /BATCH \+\S+ draft\/multiline/.test(l));
    expect(nested, 'nested multiline batch inside the chathistory batch').toBeTruthy();
    expect(msgidOf(nested!), 'msgid on the multiline opener').toBeTruthy();
    const inner = r1.lines.filter(l => / PRIVMSG / .test(l) && /line (one|two|three)/.test(l));
    expect(inner.length, 'all three lines').toBe(3);
    expect(inner.filter(l => /msgid=/.test(l)).length, 'no msgid on the inner lines').toBe(0);

    // Tier 2: a batch client WITHOUT multiline gets separate lines, msgid on the first only.
    const t2 = track(await connect(BASE, 'ml2'));
    t2.send(`JOIN ${chan}`); await t2.waitForJoin(chan);
    const r2 = await query(t2, `LATEST ${chan} * 10`);
    const lines2 = r2.lines.filter(l => / PRIVMSG /.test(l) && /line (one|two|three)/.test(l));
    expect(lines2.length, 'three separate lines').toBe(3);
    expect(lines2.filter(l => /msgid=/.test(l)).length, 'exactly one line carries the msgid').toBe(1);
    expect(/line one/.test(lines2.find(l => /msgid=/.test(l))!), 'and it is the first').toBe(true);
    expect(r2.lines.some(l => /draft\/multiline/.test(l)), 'no multiline batch for a non-multiline client').toBe(false);
  });

  it('REDACT through history: shown with message-redaction, original hidden without', async () => {
    const author = track(await connect([...BASE, 'draft/message-redaction'], 'rda'));
    const chan = uniqueChannel('rdhist');
    author.send(`JOIN ${chan}`); await author.waitForJoin(chan);
    const start = author.allLines.length;
    author.send(`PRIVMSG ${chan} :secret-${chan}`);
    author.send(`PRIVMSG ${chan} :kept-${chan}`);
    await sleep(800);
    const echoed = author.allLines.slice(start).find(l => l.includes(`secret-${chan}`))!;
    author.send(`REDACT ${chan} ${msgidOf(echoed)} :oops`);
    await sleep(1200);

    const withCap = track(await connect([...BASE, 'draft/message-redaction', 'draft/event-playback'], 'rdc'));
    withCap.send(`JOIN ${chan}`); await withCap.waitForJoin(chan);
    const r1 = await query(withCap, `LATEST ${chan} * 20`);
    expect(r1.lines.some(l => / REDACT /.test(l) && /batch=/.test(l)), 'REDACT row delivered').toBe(true);
    expect(r1.lines.some(l => l.includes(`secret-${chan}`)), 'redacted original not delivered').toBe(false);
    expect(texts(r1)).toContain(`kept-${chan}`);

    const noCap = track(await connect(BASE, 'rdn'));
    noCap.send(`JOIN ${chan}`); await noCap.waitForJoin(chan);
    const r2 = await query(noCap, `LATEST ${chan} * 20`);
    expect(r2.lines.some(l => / REDACT /.test(l)), 'no REDACT line without the cap').toBe(false);
    expect(r2.lines.some(l => l.includes(`secret-${chan}`)), 'redacted original still hidden').toBe(false);
    expect(texts(r2)).toContain(`kept-${chan}`);
  });

  it('bouncer auto-replay honours its limit and stamps the end tag only when exhausted', async () => {
    const REPLAY = ['batch', 'message-tags', 'server-time', 'echo-message', 'account-tag'];
    const LIMIT = 100; // BOUNCER_AUTO_REPLAY_LIMIT on the bed
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const a = await createBouncerClient(acc.account, acc.password, { extraCaps: REPLAY }); track(a.client);
    const big = uniqueChannel('rlbig'); const small = uniqueChannel('rlsmall');
    a.client.send(`JOIN ${big}`); await a.client.waitForJoin(big);
    a.client.send(`JOIN ${small}`); await a.client.waitForJoin(small);
    const bAcc = await getTestAccount(); if (bAcc.fromPool) pool.push(bAcc.account);
    const b = await createSaslBouncerClient(bAcc.account, bAcc.password, { extraCaps: ['echo-message'] }); track(b.client);
    b.client.send(`JOIN ${big}`); await b.client.waitForJoin(big);
    b.client.send(`JOIN ${small}`); await b.client.waitForJoin(small);

    disconnectAbruptly(a.client); await sleep(500);
    for (let i = 0; i < LIMIT + 30; i++) { b.client.send(`PRIVMSG ${big} :b${i}`); if (i % 10 === 9) await sleep(50); }
    for (let i = 0; i < 5; i++) { b.client.send(`PRIVMSG ${small} :s${i}`); }
    await sleep(2000);

    const a2 = await reconnectBouncer(acc.account, acc.password, { nick: a.nick, extraCaps: REPLAY }); track(a2.client);
    await sleep(4000);
    const lines = a2.client.allLines;
    const openerBig = lines.find(l => new RegExp(`BATCH \\+\\S+ chathistory ${big}`).test(l)) ?? '';
    const openerSmall = lines.find(l => new RegExp(`BATCH \\+\\S+ chathistory ${small}`).test(l)) ?? '';
    expect(openerBig, 'replay batch for the big channel').toBeTruthy();
    expect(openerSmall, 'replay batch for the small channel').toBeTruthy();
    const bigRows = lines.filter(l => new RegExp(` PRIVMSG ${big} :b\\d+$`).test(l) && /batch=/.test(l));
    const smallRows = lines.filter(l => new RegExp(` PRIVMSG ${small} :s\\d+$`).test(l) && /batch=/.test(l));
    expect(bigRows.length, 'exactly the limit for the big channel').toBe(LIMIT);
    expect(bigRows.some(l => /:b129$/.test(l)) && !bigRows.some(l => /:b0$/.test(l)), 'the NEWEST limit rows').toBe(true);
    expect(/draft\/chathistory-end/.test(openerBig), 'no end tag on the truncated leg').toBe(false);
    expect(smallRows.length, 'all rows for the small channel').toBe(5);
    expect(/draft\/chathistory-end/.test(openerSmall), 'end tag on the exhausted leg').toBe(true);
  });
});
