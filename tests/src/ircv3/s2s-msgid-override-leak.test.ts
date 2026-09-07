import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick, X3Client, RawSocketClient, SECONDARY_SERVER,
  getTestAccount, releaseTestAccount, createSaslBouncerClient, createRawSocketClient,
} from '../helpers/index.js';

/**
 * Stale S2S tag override after an account or away change (found 2026-09-04
 * while chasing eck's INVALID_TARGET report).
 *
 * m_account / m_away armed the S2S msgid+time override with
 * sendcmdto_set_s2s_tags() and relayed with sendcmdto_serv_butone(), which
 * only consumed the override on its tagged path.  Nothing armed that path,
 * so the override survived the relay and stamped the NEXT server-bound
 * PRIVMSG with the auth-time msgid and timestamp: several distinct messages
 * shared one msgid, and stored rows carried a time seconds before they were
 * sent.  Observable end to end: the live @msgid/@time on a cross-server PM
 * received seconds after the other party authenticated or went away.
 */

const TAGS = ['message-tags', 'server-time'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tagsOf(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!line.startsWith('@')) return out;
  for (const kv of line.slice(1).split(' ')[0].split(';')) {
    const i = kv.indexOf('=');
    out[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '' : kv.slice(i + 1);
  }
  return out;
}

function pmLine(c: RawSocketClient, text: string): string {
  const l = c.allLines.find(x => x.includes('PRIVMSG') && x.endsWith(':' + text));
  expect(l, `no PRIVMSG ending in "${text}" reached ${c === undefined ? '?' : 'client'}`).toBeTruthy();
  return l!;
}

/** The message's own time, not the time of the last account/away change. */
function expectFresh(line: string, sentAt: number, what: string) {
  const t = tagsOf(line);
  expect(t.msgid, `${what}: no msgid on ${line}`).toBeTruthy();
  const ms = Date.parse(t.time);
  expect(Math.abs(ms - sentAt), `${what}: @time ${t.time} is ${Math.round((ms - sentAt) / 1000)} s from the send (stale override?): ${line}`).toBeLessThan(2000);
  return t.msgid;
}

describe('S2S tag override does not leak past an ACCOUNT or AWAY relay', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('PMs relayed after a remote AUTH and AWAY carry their own msgid and time', async () => {
    const accP = await getTestAccount(); if (accP.fromPool) pool.push(accP.account);
    const accQ = await getTestAccount(); if (accQ.fromPool) pool.push(accQ.account);

    // P on the hub, authenticated by SASL.  T on the hub, a guest.
    const p = await createSaslBouncerClient(accP.account, accP.password, { nick: uniqueNick('ovp'), extraCaps: TAGS });
    clients.push(p.client);
    const t = await createRawSocketClient();
    clients.push(t);
    const tnick = uniqueNick('ovt');
    await t.capLs(); await t.capReq(TAGS); t.capEnd(); t.register(tnick);
    await t.waitForNumeric('001'); await sleep(300);

    // Q on the leaf, authenticating AFTER registration: the ACCOUNT token
    // crosses the link and arms the override on both servers.
    const q = new X3Client();
    await q.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    await q.capLs(); await q.capReq(TAGS); q.capEnd();
    const qnick = uniqueNick('ovq');
    q.register(qnick);
    await q.waitForNumeric('001');
    clients.push(q);
    await sleep(300);
    const auth = await q.auth(accQ.account, accQ.password, 30000);
    expect(auth.success, auth.lines.join('\n')).toBe(true);
    await sleep(3000);   /* well clear of the auth moment */

    const t1 = Date.now(); p.client.send(`PRIVMSG ${qnick} :hub to leaf after auth`);
    await sleep(700);
    const t2 = Date.now(); q.send(`PRIVMSG ${p.nick} :leaf to hub after auth`);
    await sleep(700);
    const t3 = Date.now(); t.send(`PRIVMSG ${qnick} :guest to leaf after auth`);
    await sleep(1500);

    const m1 = expectFresh(pmLine(q, 'hub to leaf after auth'), t1, 'P->Q');
    const m2 = expectFresh(pmLine(p.client, 'leaf to hub after auth'), t2, 'Q->P');
    const m3 = expectFresh(pmLine(q, 'guest to leaf after auth'), t3, 'T->Q');
    expect(new Set([m1, m2, m3]).size, `msgids not distinct: ${m1} ${m2} ${m3}`).toBe(3);

    // AWAY relays the same way.
    q.send('AWAY :lunch');
    await sleep(3000);
    const t4 = Date.now(); t.send(`PRIVMSG ${qnick} :guest to leaf after away`);
    await sleep(700);
    const t5 = Date.now(); q.send(`PRIVMSG ${tnick} :leaf to guest after away`);
    await sleep(1500);
    const m4 = expectFresh(pmLine(q, 'guest to leaf after away'), t4, 'T->Q after AWAY');
    const m5 = expectFresh(pmLine(t, 'leaf to guest after away'), t5, 'Q->T after AWAY');
    expect(new Set([m3, m4, m5]).size).toBe(3);
    q.send('AWAY');
  }, 90000);
});
