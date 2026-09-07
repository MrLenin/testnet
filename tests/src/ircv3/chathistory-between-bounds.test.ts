import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick, X3Client, RawSocketClient,
  getTestAccount, releaseTestAccount, createSaslBouncerClient, createRawSocketClient,
} from '../helpers/index.js';

/**
 * CHATHISTORY BETWEEN stays inside the requested target and window
 * (2026-09-05, found by replaying goguma's backlog sequence).
 *
 * The BETWEEN walk seeks to <target>\0<from> and stops at the first key
 * >= <target>\0<to> -- but only tested keys at least as long as that end
 * prefix.  A guest's pair key carries a 22-char session id, so every key
 * of a SHORTER pair that sorts after it (the account's own self-pair,
 * account:account pairs) slipped past the check: once the guest's rows
 * were exhausted the walk kept going through other conversations, with
 * no window applied, until the limit.  goguma fetches ALL backlog with
 * BETWEEN, so its PM buffers filled with other people's messages.
 */

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('CHATHISTORY BETWEEN is bounded to its target', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('a guest pair window does not spill into the account\'s other conversations', async () => {
    // Session ids are time-ordered, so the guest made below is the account's
    // newest guest pair: the last long key before the account's short ones.
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const me = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('btw'), extraCaps: CH });
    clients.push(me.client);
    const other = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('btx') });
    clients.push(other.client);
    await sleep(500);

    // Self-pair rows (account:account): a SHORTER key than any guest pair.
    for (let i = 0; i < 5; i++) { me.client.send(`PRIVMSG ${other.nick} :self ${i}`); await sleep(150); }

    // A guest partner: pair keyed by their session id.
    const j = await createRawSocketClient();
    clients.push(j);
    const jnick = uniqueNick('guest');
    await j.capLs(); j.capEnd(); j.register(jnick);
    await j.waitForNumeric('001'); await sleep(300);
    me.client.send(`PRIVMSG ${jnick} :to guest`); await sleep(300);
    j.send(`PRIVMSG ${me.nick} :from guest`); await sleep(1500);

    const from = new Date(Date.now() - 600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const start = me.client.allLines.length;
    me.client.send(`CHATHISTORY BETWEEN ${jnick} timestamp=${from} timestamp=${to} 100`);
    await sleep(2500);
    const lines = me.client.allLines.slice(start);
    const open = lines.find(l => / BATCH \+\S+ chathistory /.test(l));
    expect(open, `no batch: ${lines.join('\n')}`).toBeTruthy();
    const id = / BATCH \+(\S+) /.exec(open!)![1];
    const rows = lines.filter(l => l.includes(`batch=${id}`) && / PRIVMSG /.test(l));
    const foreign = rows.filter(l => !l.includes(jnick));
    expect(foreign, `rows from other conversations leaked into the guest pair:\n${foreign.join('\n')}`).toEqual([]);
    expect(rows.length).toBe(2);
  }, 90000);
});
