import { describe, it, expect, afterEach } from 'vitest';
import { uniqueNick, RawSocketClient, getTestAccount, releaseTestAccount, createSaslBouncerClient, createRawSocketClient } from '../helpers/index.js';

/**
 * CHATHISTORY TARGETS lists the requester's targets however many other
 * targets the server holds (2026-09-05).
 *
 * The walk collected the first 3x<limit> window-matching targets in KEY
 * order, then filtered by access.  Any server with more active targets
 * than that -- the bed has ~3000, prod ~3500 -- silently dropped the
 * requester's own conversations behind other people's channels that sort
 * earlier: a 30-day TARGETS on the bed returned one target where a 12-hour
 * one returned 22.  goguma fetches ALL backlog from TARGETS, so nothing
 * loaded.  The access filter now runs inside the walk.
 */

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('CHATHISTORY TARGETS is not crowded out by other people\'s targets', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('lists the requester\'s channel with limit 1 although four inaccessible channels sort before it', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    // Someone else's channels, active now, sorting before ours in key order.
    const x = await createRawSocketClient();
    clients.push(x);
    await x.capLs(); x.capEnd(); x.register(uniqueNick('crowd'));
    await x.waitForNumeric('001'); await sleep(300);
    for (let i = 0; i < 4; i++) {
      x.send(`JOIN #aaa-${tag}-${i}`); await sleep(200);
      x.send(`PRIVMSG #aaa-${tag}-${i} :noise ${i}`); await sleep(200);
    }
    // The requester's channel, sorting after them.
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const me = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('tgt'), extraCaps: CH });
    clients.push(me.client);
    const mine = `#zzz-${tag}`;
    me.client.send(`JOIN ${mine}`); await sleep(500);
    me.client.send(`PRIVMSG ${mine} :mine`); await sleep(1500);

    const from = new Date(Date.now() - 300_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const start = me.client.allLines.length;
    me.client.send(`CHATHISTORY TARGETS timestamp=${from} timestamp=${to} 1`);
    await sleep(2500);
    const lines = me.client.allLines.slice(start);
    const rows = lines.filter(l => / CHATHISTORY TARGETS /.test(l)).map(l => / CHATHISTORY TARGETS (\S+) /.exec(l)![1]);
    expect(rows, `TARGETS rows: ${lines.filter(l => /BATCH|TARGETS/.test(l)).join('\n')}`).toEqual([mine]);
  }, 60000);
});
