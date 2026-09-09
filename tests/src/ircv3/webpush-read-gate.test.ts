/**
 * Read-marker pushes only when they can clear something (2026-09-09,
 * evilnet/nefarious2 #110).
 *
 * A read marker used to be relayed to the account's push subscriptions
 * unconditionally (coalesced per target).  A subscription that receives
 * a push it shows nothing for makes Chrome display its generic "site
 * updated in the background" notification, so every MARKREAD on a quiet
 * conversation became a spurious notification on such clients (#110).
 *
 * The push exists so OTHER devices can close a notification the server
 * pushed.  So it goes out only when a message push for that target is
 * newer than the last read push for it; otherwise there is nothing to
 * clear and nothing is sent.  Same observable as webpush-attention:
 * `STATS webpush` "Pushes since boot: N sent".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import {
  uniqueNick, uniqueId, uniqueChannel, X3Client, RawSocketClient, IRC_OPER,
  getTestAccount, releaseTestAccount, createBouncerClient, bouncerDisableHold,
  createRawSocketClient, disconnectAbruptly, reconnectBouncer,
} from '../helpers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function pushKeys(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return `p256dh=${p256dh};auth=${randomBytes(16).toString('base64url')}`;
}
async function operUp(): Promise<RawSocketClient> {
  const o = await createRawSocketClient();
  await o.capLs(); o.capEnd(); o.register(uniqueNick('wprop'));
  await o.waitForNumeric('001'); await sleep(300);
  o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await o.waitForNumeric('381', 20000);
  return o;
}
async function sent(o: RawSocketClient): Promise<number> {
  o.clearRawBuffer(); o.send('STATS webpush');
  let n = -1;
  for (;;) {
    const m = await o.waitForParsedLine(x => x.command === '249' || x.command === '219', 5000);
    if (m.command === '219') break;
    const r = /Pushes since boot: (\d+) sent/.exec(m.params[m.params.length - 1]);
    if (r) n = parseInt(r[1], 10);
  }
  expect(n, 'STATS webpush has no push counters').toBeGreaterThanOrEqual(0);
  return n;
}
const now = () => new Date().toISOString();

describe('draft/webpush read-marker gate', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const pool: string[] = [];
  const track = <T extends X3Client | RawSocketClient>(c: T): T => { clients.push(c); return c; };
  let oper: RawSocketClient | null = null;
  let endpointOwner: { c: X3Client; endpoint: string } | null = null;
  afterEach(async () => {
    if (endpointOwner) { try { endpointOwner.c.send(`WEBPUSH UNREGISTER ${endpointOwner.endpoint}`); } catch { /* */ } endpointOwner = null; await sleep(300); }
    if (oper) { try { oper.send('RESET WEBPUSH_IDLE'); oper.send('RESET WEBPUSH_COOLDOWN'); } catch { /* */ } await sleep(300); oper = null; }
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch { /* */ } try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });

  it('a read marker pushes only when a message push for that target is outstanding', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const p = await createBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('wprd'), extraCaps: ['draft/webpush', 'draft/read-marker'],
    });
    track(p.client);
    const nick = p.nick;
    await sleep(800);
    const endpoint = `https://webhook.site/${uniqueId()}-readgate`;
    p.client.clearRawBuffer();
    p.client.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointOwner = { c: p.client, endpoint };
    oper = track(await operUp());
    oper.send('SET WEBPUSH_COOLDOWN 0');
    await sleep(300);

    const chan = uniqueChannel('rdgate');
    p.client.send(`JOIN ${chan}`); await p.client.waitForJoin(chan);
    const sender = track(await createRawSocketClient());
    await sender.capLs(); sender.capEnd(); sender.register(uniqueNick('wpsnd'));
    await sender.waitForNumeric('001'); await sleep(300);

    // 1. Nothing has been pushed: a read marker on a quiet channel and on a
    //    quiet PM must push nothing.
    const c0 = await sent(oper);
    p.client.send(`MARKREAD ${chan} timestamp=${now()}`);
    p.client.send(`MARKREAD ${sender.nick ?? 'nobody'} timestamp=${now()}`);
    await sleep(1200);
    expect(await sent(oper), 'no push to clear: no read push').toBe(c0);

    // 2. Hold the session (unattended), get a PM pushed.
    disconnectAbruptly(p.client);
    await sleep(800);
    const senderNick = uniqueNick('wpsnd2');
    const s2 = track(await createRawSocketClient());
    await s2.capLs(); s2.capEnd(); s2.register(senderNick); await s2.waitForNumeric('001'); await sleep(300);
    s2.send(`PRIVMSG ${nick} :ping while held`);
    await sleep(1500);
    const c1 = await sent(oper);
    expect(c1, 'the PM was pushed').toBe(c0 + 1);

    // 3. The account reads that PM from another device: one read push, so
    //    the pushed notification can be closed there ...
    const back = await reconnectBouncer(acc.account, acc.password, { nick, extraCaps: ['draft/webpush', 'draft/read-marker'] });
    track(back.client);
    await sleep(800);
    back.client.send(`MARKREAD ${senderNick} timestamp=${now()}`);
    await sleep(1200);
    expect(await sent(oper), 'one read push after a message push').toBe(c1 + 1);

    // 4. ... and reading it again, with nothing new pushed, pushes nothing.
    await sleep(3500);   // past the read coalesce window
    back.client.send(`MARKREAD ${senderNick} timestamp=${now()}`);
    await sleep(1200);
    expect(await sent(oper), 'nothing new to clear: no second read push').toBe(c1 + 1);
  });
});
