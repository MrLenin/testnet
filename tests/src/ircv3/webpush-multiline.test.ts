import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { uniqueNick, uniqueId, X3Client, RawSocketClient, IRC_OPER, SECONDARY_SERVER,
  getTestAccount, releaseTestAccount, createBouncerClient, createSaslBouncerClient, bouncerDisableHold, createRawSocketClient } from '../helpers/index.js';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function pushKeys(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  return `p256dh=${p256dh};auth=${randomBytes(16).toString('base64url')}`;
}
async function operUp(host?: string, port?: number): Promise<RawSocketClient> {
  const o = await createRawSocketClient(host, port); await o.capLs(); o.capEnd(); o.register(uniqueNick('mlop'));
  await o.waitForNumeric('001'); await sleep(300); o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`); await o.waitForNumeric('381', 20000); return o;
}
async function sent(o: RawSocketClient): Promise<number> {
  o.clearRawBuffer(); o.send('STATS webpush'); let n = -1;
  for (;;) { const m = await o.waitForParsedLine(x => x.command === '249' || x.command === '219', 30000)   /* each push = ECDH + ES256; ~2 s under valgrind */; if (m.command === '219') break;
    const r = /Pushes since boot: (\d+) sent/.exec(m.params[m.params.length - 1]); if (r) n = parseInt(r[1], 10); }
  expect(n).toBeGreaterThanOrEqual(0); return n;
}
describe('draft/webpush: multiline batches push (PR 107)', () => {
  const clients: RawSocketClient[] = []; const pool: string[] = []; let oper: RawSocketClient | null = null; let owner: { c: RawSocketClient; ep: string } | null = null;
  afterEach(async () => {
    if (owner) { try { owner.c.send(`WEBPUSH UNREGISTER ${owner.ep}`); } catch {} await sleep(300); owner = null; }
    if (oper) { try { oper.send('RESET WEBPUSH_IDLE'); oper.send('RESET WEBPUSH_COOLDOWN'); oper.send('RESET WEBPUSH_MULTILINE_LINES'); } catch {} await sleep(300); oper = null; }
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch {} try { c.send('QUIT'); c.close(); } catch {} }
    clients.length = 0; for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });
  it('a multiline PM to an idle account pushes one notification per line, capped; remote sender too', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const p = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('mlp'), extraCaps: ['draft/webpush'] });
    clients.push(p.client); await sleep(400);
    const ep = `https://webhook.site/${uniqueId()}-ml`;
    p.client.clearRawBuffer(); p.client.send(`WEBPUSH REGISTER ${ep} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH'); owner = { c: p.client, ep };
    oper = await operUp(); clients.push(oper);
    oper.send('SET WEBPUSH_IDLE 3'); oper.send('SET WEBPUSH_COOLDOWN 0'); oper.send('SET WEBPUSH_MULTILINE_LINES 3'); await sleep(500);
    await sleep(4000);   /* p idle past the window */
    // local sender, 5-line batch -> capped to 3 pushes
    const s = await createRawSocketClient(); clients.push(s); await s.capLs(); await s.capReq(['batch', 'draft/multiline', 'message-tags']); s.capEnd(); s.register(uniqueNick('mls'));
    await s.waitForNumeric('001'); await sleep(300);
    // The "sent" counter is per SUBSCRIPTION and there is no WEBPUSH LIST to
    // clear a pool account's stale endpoints (three of them made a 3-push
    // batch count 9, 2026-09-09): measure the factor with one single push
    // first, then expect multiples of it.
    const cA = await sent(oper);
    s.send(`PRIVMSG ${p.nick} :calibrate`); await sleep(2500);
    const subs = (await sent(oper)) - cA;
    expect(subs, 'a single PM pushes once per subscription').toBeGreaterThanOrEqual(1);
    await sleep(4000);   /* idle again */
    const c0 = await sent(oper);
    s.send(`BATCH +m1 draft/multiline ${p.nick}`);
    for (let i = 1; i <= 5; i++) s.send(`@batch=m1 PRIVMSG ${p.nick} :line ${i}`);
    s.send('BATCH -m1'); await sleep(3000);
    const c1 = await sent(oper);
    expect(c1 - c0, 'local 5-line batch with cap 3').toBe(3 * subs);
    // remote sender on the leaf, 2-line batch -> 2 pushes
    await sleep(4000);
    const r = await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port); clients.push(r);
    await r.capLs(); await r.capReq(['batch', 'draft/multiline', 'message-tags']); r.capEnd(); r.register(uniqueNick('mlr'));
    await r.waitForNumeric('001'); await sleep(300);
    const c2 = await sent(oper);
    r.send(`BATCH +m2 draft/multiline ${p.nick}`); r.send(`@batch=m2 PRIVMSG ${p.nick} :remote one`); r.send(`@batch=m2 PRIVMSG ${p.nick} :remote two`); r.send('BATCH -m2');
    await sleep(3000);
    const c3 = await sent(oper);
    expect(c3 - c2, 'remote 2-line batch').toBe(2 * subs);
    // single PM still one push
    await sleep(4000);
    const c4 = await sent(oper); s.send(`PRIVMSG ${p.nick} :single`); await sleep(2500);
    expect((await sent(oper)) - c4).toBe(subs);
  }, 120000);
});
