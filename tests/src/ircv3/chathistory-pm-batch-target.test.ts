import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick, X3Client, RawSocketClient, PRIMARY_SERVER,
  getTestAccount, releaseTestAccount, createBouncerClient, bouncerDisableHold,
  createRawSocketClient,
} from '../helpers/index.js';

/**
 * An on-demand CHATHISTORY reply names its batch after the target the
 * client asked for (2026-09-04).
 *
 * The batch target used to be derived from the storage pair key: for an
 * empty page about an unauthenticated online partner that was their
 * session id; for two connections of one account it was whichever live
 * client on the account came first, often the requester's own nick.
 * Clients key buffers on the batch target, so either lands history in
 * the wrong window.
 */

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function query(c: RawSocketClient, target: string) {
  const start = c.allLines.length;
  c.send(`CHATHISTORY LATEST ${target} * 50`);
  await sleep(2000);
  const lines = c.allLines.slice(start);
  const open = lines.find(l => / BATCH \+\S+ chathistory /.test(l));
  const fail = lines.find(l => / FAIL CHATHISTORY /.test(l));
  expect(fail, fail).toBeUndefined();
  expect(open, `no chathistory batch for ${target}: ${lines.join('\n')}`).toBeTruthy();
  const m = / BATCH \+(\S+) chathistory (\S+)/.exec(open!)!;
  const rows = lines.filter(l => l.includes(`@batch=${m[1]}`) || l.includes(`batch=${m[1]};`));
  return { target: m[2], rows };
}

describe('CHATHISTORY batch target is the requested target', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch { /* */ } try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('an empty page about an unauthenticated online partner is named after them, not their session id', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const me = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('bt'), extraCaps: CH });
    clients.push(me.client);
    const j = await createRawSocketClient();
    clients.push(j);
    const jnick = uniqueNick('Guest');
    await j.capLs(); j.capEnd(); j.register(jnick);
    await j.waitForNumeric('001'); await sleep(300);

    const r = await query(me.client, jnick);
    expect(r.target).toBe(jnick);
    expect(r.rows.length).toBe(0);
  }, 60000);

  it('two connections of one account: the page is named after the nick asked about', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const me = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('bta'), extraCaps: CH });
    clients.push(me.client);

    // Second connection on the SAME account, logged in after registration
    // so it stays outside the bouncer session.
    const other = new X3Client();
    await other.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await other.capLs(); await other.capReq(CH); other.capEnd();
    const onick = uniqueNick('btb');
    other.register(onick);
    await other.waitForNumeric('001');
    clients.push(other);
    await sleep(300);
    const auth = await other.auth(acc.account, acc.password, 30000);
    expect(auth.success, auth.lines.join('\n')).toBe(true);
    await sleep(1000);

    const marker = uniqueNick('m');
    me.client.send(`PRIVMSG ${onick} :to my other device ${marker}`);
    await sleep(500);
    other.send(`PRIVMSG ${me.nick} :back to the first ${marker}`);
    await sleep(1500);

    const a = await query(me.client, onick);
    expect(a.target).toBe(onick);
    const own = a.rows.find(l => l.endsWith(`:to my other device ${marker}`));
    expect(own, 'own row missing').toBeTruthy();
    expect(own!, 'own row must be addressed to the nick asked about').toContain(` PRIVMSG ${onick} :`);

    const b = await query(other, me.nick);
    expect(b.target).toBe(me.nick);
  }, 90000);
});
