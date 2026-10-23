import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick, RawSocketClient, getTestAccount, releaseTestAccount,
  createSaslBouncerClient,
} from '../helpers/index.js';

/**
 * CHATHISTORY TARGETS sets draft/chathistory-end only when the network was
 * exhausted (Seance PR #121 server notes, 2026-10-21).  When the local walk
 * filled the page, federation was skipped, yet the batch still said
 * complete: other storage servers could hold targets that belong on the
 * page, and a client that skips by the end tag never asks again.
 *
 * Assumes federation is on and at least one other storage server is linked
 * (the bed: testnet and leaf both store).
 */
const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('CHATHISTORY TARGETS end tag', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  /** TARGETS over a window that holds only this test's channel. */
  async function targets(c: RawSocketClient, from: string, limit: number) {
    const to = new Date(Date.now() + 60_000).toISOString();
    const start = c.allLines.length;
    c.send(`CHATHISTORY TARGETS timestamp=${from} timestamp=${to} ${limit}`);
    await sleep(3000);
    const lines = c.allLines.slice(start);
    const opener = lines.find(l => / BATCH \+\S+ draft\/chathistory-targets/.test(l)) ?? '';
    const rows = lines.filter(l => / CHATHISTORY TARGETS /.test(l));
    return { opener, rows, dump: lines.filter(l => /BATCH|TARGETS/.test(l)).join('\n') };
  }

  async function oneTarget() {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const me = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('tend'), extraCaps: CH });
    clients.push(me.client);
    await sleep(1500);
    const from = new Date(Date.now() - 1000).toISOString();
    const chan = `#tend-${Math.random().toString(36).slice(2, 8)}`;
    me.client.send(`JOIN ${chan}`); await sleep(500);
    me.client.send(`PRIVMSG ${chan} :only target`); await sleep(1500);
    return { client: me.client, from };
  }

  it('a page filled by the local walk alone is not marked complete', async () => {
    const { client, from } = await oneTarget();
    const r = await targets(client, from, 1);
    expect(r.rows.length, r.dump).toBe(1);
    expect(r.opener, `the other storage servers were never asked:\n${r.dump}`)
      .not.toMatch(/draft\/chathistory-end/);
  }, 60000);

  it('control: a page with room left, after federating, is marked complete', async () => {
    const { client, from } = await oneTarget();
    const r = await targets(client, from, 5);
    expect(r.rows.length, r.dump).toBe(1);
    expect(r.opener, r.dump).toMatch(/draft\/chathistory-end/);
  }, 60000);
});
