/**
 * evilnet.github.io/chathistory-partial and its companions (2026-09-08).
 * Contract: docs/features/chathistory.md, "Completeness".
 *
 *  1. While a storage server the origin has seen is SPLIT, an answer whose
 *     span overlaps the absence carries the partial tag and no end tag.
 *  2. After the heal, a query over the split window is complete, and it
 *     fans out even though the local page is full, so the other side's
 *     rows appear (same channel incarnation on both sides).
 *  3. A channel RECREATED on the split side (new creation timestamp; the
 *     burst wipes it on relink) is a different incarnation: its rows never
 *     reach a main-side member's page.
 *  4. Storage follows the retrieval policy: with CHATHISTORY_REQUIRE_AUTH on
 *     and no authenticated member present, the row is not stored.
 *
 * Linked bed, SQUIT/CONNECT of the leaf as in channel-redirect-reset.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient, RawSocketClient, PRIMARY_SERVER, SECONDARY_SERVER, IRC_OPER,
  uniqueChannel, uniqueNick, getTestAccount, releaseTestAccount, authenticateSaslPlain,
} from '../helpers/index.js';

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message', 'sasl'];
const PARTIAL = 'evilnet.github.io/chathistory-partial';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Reply { opener: string; rows: string[]; partial: boolean; end: boolean }
async function query(c: RawSocketClient, cmd: string): Promise<Reply> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY ${cmd}`);
  await c.waitForLine(/:\S+ BATCH -hist\d+\s*$|FAIL CHATHISTORY/, 12000);
  const lines = c.allLines.slice(start);
  const opener = lines.find(l => /BATCH \+hist\d+ chathistory/.test(l)) ?? '';
  const rows = lines.filter(l => /^@[^ ]*batch=hist/.test(l) && / PRIVMSG /.test(l)).map(l => l.replace(/^.* PRIVMSG \S+ :/, ''));
  const tags = opener.startsWith('@') ? opener.slice(1).split(' ')[0] : '';
  return { opener, rows, partial: tags.split(';').includes(PARTIAL), end: tags.split(';').includes('draft/chathistory-end') };
}

async function authed(server: typeof PRIMARY_SERVER, prefix: string, pool: string[]) {
  const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs(); await c.capReq(CH);
  const r = await authenticateSaslPlain(c, acc.account, acc.password);
  if (!r.success) throw new Error(`SASL failed: ${r.error}`);
  c.capEnd(); c.register(uniqueNick(prefix));
  await c.waitForNumeric('001'); await sleep(300);
  return c;
}
async function plain(server: typeof PRIMARY_SERVER, prefix: string) {
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs(); await c.capReq(CH.filter(x => x !== 'sasl')); c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001'); await sleep(300);
  return c;
}
async function operOn(server: typeof PRIMARY_SERVER) {
  const c = await plain(server, 'pop');
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForNumeric('381', 8000);
  return c;
}
async function splitLeaf(operP: RawSocketClient, operS: RawSocketClient) {
  operP.send('SQUIT leaf.fractalrealities.net :partial test');
  let seen = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000); operS.clearRawBuffer(); operS.send('LINKS');
    try { await operS.waitForLine(/testnet\.fractalrealities\.net/i, 1500); } catch { seen = true; break; }
  }
  expect(seen, 'leaf never saw the split').toBe(true);
}
async function healLeaf(operP: RawSocketClient) {
  operP.send('CONNECT leaf.fractalrealities.net');
  let healed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000); operP.clearRawBuffer(); operP.send('LINKS');
    try { await operP.waitForLine(/leaf\.fractalrealities\.net/i, 1500); healed = true; break; } catch { /* */ }
  }
  expect(healed, 'link did not heal').toBe(true);
  await sleep(3000);   // burst + ad re-flood
}

describe('chathistory-partial: split windows', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0;
    for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });

  it('partial while a known store is split; complete and fanned out after the heal (same incarnation)', async () => {
    const chan = uniqueChannel('part');
    const operP = await operOn(PRIMARY_SERVER); const operS = await operOn(SECONDARY_SERVER);
    clients.push(operP, operS);
    const p = await authed(PRIMARY_SERVER, 'pa', pool); const s = await authed(SECONDARY_SERVER, 'sb', pool);
    clients.push(p, s);
    p.send(`JOIN ${chan}`); await p.waitForJoin(chan);
    s.send(`JOIN ${chan}`); await s.waitForJoin(chan);
    await sleep(500);
    for (let i = 0; i < 3; i++) { p.send(`PRIVMSG ${chan} :pre${i}`); await sleep(60); }
    await sleep(800);

    await splitLeaf(operP, operS);
    let healed = false;
    try {
      // Both sides keep the channel (a member on each): same incarnation.
      s.send(`PRIVMSG ${chan} :leaf-only-1`); await sleep(60);
      s.send(`PRIVMSG ${chan} :leaf-only-2`); await sleep(60);
      p.send(`PRIVMSG ${chan} :hub-during`); await sleep(1000);

      // 1. During the split: the leaf is a known storage server, absent.
      const during = await query(p, `LATEST ${chan} * 3`);
      expect(during.partial, 'partial while the leaf is split').toBe(true);
      expect(during.end, 'no end tag on a partial page').toBe(false);
      expect(during.rows).toEqual(['pre1', 'pre2', 'hub-during']);

      await healLeaf(operP); healed = true;
    } finally {
      if (!healed) await healLeaf(operP);
    }

    // 2. After the heal: the local page is full (3 local rows newer than the
    //    window start), yet the answer fans out because the span overlaps
    //    the leaf's absence, and the leaf-only rows are merged in.  The
    //    absence closes when the leaf's storage ad arrives at END_OF_BURST,
    //    which lags the link under valgrind: poll until the page is not
    //    partial (that window is partial by contract).
    let after = await query(p, `LATEST ${chan} * 3`);
    for (let i = 0; i < 20 && after.partial; i++) { await sleep(1000); after = await query(p, `LATEST ${chan} * 3`); }
    expect(after.partial, 'complete once the leaf advertises again').toBe(false);
    expect(after.rows, 'leaf rows merged although the local page was full').toEqual(['leaf-only-1', 'leaf-only-2', 'hub-during']);
    expect(after.end, 'a full page is not the end').toBe(false);
  });

  it('a channel recreated on the split side is a different incarnation: its rows never surface', async () => {
    const chan = uniqueChannel('inc');
    const operP = await operOn(PRIMARY_SERVER); const operS = await operOn(SECONDARY_SERVER);
    clients.push(operP, operS);
    const p = await authed(PRIMARY_SERVER, 'ia', pool);
    clients.push(p);
    p.send(`JOIN ${chan}`); await p.waitForJoin(chan);   // exists on the hub only
    p.send(`PRIVMSG ${chan} :hub-before`); await sleep(800);

    await splitLeaf(operP, operS);
    let healed = false;
    try {
      // On the leaf the channel does not exist: an outsider creates it fresh.
      const bad = await authed(SECONDARY_SERVER, 'bad', pool); clients.push(bad);
      bad.send(`JOIN ${chan}`); await bad.waitForJoin(chan);
      bad.send(`PRIVMSG ${chan} :BAD-THINGS-1`); await sleep(60);
      bad.send(`PRIVMSG ${chan} :BAD-THINGS-2`); await sleep(60);
      p.send(`PRIVMSG ${chan} :hub-during`); await sleep(1000);
      await healLeaf(operP); healed = true;
    } finally {
      if (!healed) await healLeaf(operP);
    }
    // The burst wiped the leaf's incarnation.  A hub member, present the whole
    // time, pages the split window: complete, and free of the outsider's rows.
    const r = await query(p, `LATEST ${chan} * 20`);
    expect(r.partial, 'complete after the heal').toBe(false);
    expect(r.rows.some(t => t.startsWith('BAD-THINGS')), 'losing-incarnation rows excluded').toBe(false);
    expect(r.rows).toEqual(['hub-before', 'hub-during']);
    p.send(`PRIVMSG ${chan} :hub-after`); await sleep(800);
    const r2 = await query(p, `LATEST ${chan} * 20`);
    expect(r2.rows).toEqual(['hub-before', 'hub-during', 'hub-after']);

    // The leaf itself PRUNED the losing incarnation at the burst: a member on
    // the leaf, joined after the heal, pages the channel and sees only the
    // surviving history (including the hub's split-window row via fan-out).
    const l = await authed(SECONDARY_SERVER, 'lf', pool); clients.push(l);
    l.send(`JOIN ${chan}`); await l.waitForJoin(chan);
    l.send(`PRIVMSG ${chan} :leaf-after`); await sleep(800);
    const rl = await query(l, `LATEST ${chan} * 20`);
    expect(rl.rows.some(t => t.startsWith('BAD-THINGS')), 'pruned on the losing side').toBe(false);
    expect(rl.rows, 'leaf sees its own post-heal row').toContain('leaf-after');
  });
});

describe('chathistory-partial: storage follows the retrieval policy', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0;
    for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });

  it('with CHATHISTORY_REQUIRE_AUTH on, a row with no authenticated member present is not stored', async () => {
    const chan = uniqueChannel('gate');
    const oper = await operOn(PRIMARY_SERVER); clients.push(oper);
    // Restore the bed's own values afterwards: leaving STRICT_PRESENCE
    // flipped broke later suites (2026-09-08).
    const prior = async (name: string) => {
      oper.send(`GET ${name}`);
      const r = await oper.waitForNumeric('284', 5000);
      return /: TRUE/.test(r.raw) ? 'TRUE' : 'FALSE';
    };
    const priorAuth = await prior('CHATHISTORY_REQUIRE_AUTH');
    const priorPresence = await prior('CHATHISTORY_STRICT_PRESENCE');
    oper.send('SET CHATHISTORY_REQUIRE_AUTH TRUE');
    oper.send('SET CHATHISTORY_STRICT_PRESENCE FALSE');
    await sleep(400);
    try {
      const u1 = await plain(PRIMARY_SERVER, 'un1'); const u2 = await plain(PRIMARY_SERVER, 'un2');
      clients.push(u1, u2);
      u1.send(`JOIN ${chan}`); await u1.waitForJoin(chan);
      u2.send(`JOIN ${chan}`); await u2.waitForJoin(chan);
      u1.send(`PRIVMSG ${chan} :nobody-can-fetch-this`); await sleep(500);
      // An authenticated member arrives; from now on rows have an audience.
      const a = await authed(PRIMARY_SERVER, 'au', pool); clients.push(a);
      a.send(`JOIN ${chan}`); await a.waitForJoin(chan);
      u1.send(`PRIVMSG ${chan} :fetchable`); await sleep(1000);
      const r = await query(a, `LATEST ${chan} * 20`);
      expect(r.rows, 'the unretrievable row was never stored').toEqual(['fetchable']);
    } finally {
      oper.send(`SET CHATHISTORY_REQUIRE_AUTH ${priorAuth}`);
      oper.send(`SET CHATHISTORY_STRICT_PRESENCE ${priorPresence}`);
      await sleep(300);
    }
  });
});
