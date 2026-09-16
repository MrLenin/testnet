import { describe, it, expect, afterEach } from 'vitest';
import {
  X3Client,
  RawSocketClient,
  createRawSocketClient,
  createBouncerClient,
  createSaslBouncerClient,
  getTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
  uniqueNick,
  uniqueChannel,
} from '../helpers/index.js';

/**
 * draft/pre-away on the wire, as others see it.
 *
 * "An away message of * should be treated as though the connection did not
 * exist at all."  So: a star next to a present sibling changes nothing for
 * anyone; a star on the user's only connection makes the user away, and
 * what away-notify and WHOIS carry is the star ITSELF, not a word.  A
 * pre-away-capable client recognises the star and prints nothing; before,
 * the server substituted "Away", which no client could tell from a real
 * away, and every app switch announced away/back to everyone.
 */
describe('draft/pre-away star as seen by others', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch { /* */ } try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('a lone AWAY * reaches a pre-away client as the star and a legacy client as the configured word; a star beside a present sibling is invisible', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const ch = uniqueChannel('star');
    const legacy = await createRawSocketClient(); clients.push(legacy);
    await legacy.capLs(); await legacy.capReq(['away-notify', 'message-tags']); legacy.capEnd();
    legacy.register(uniqueNick('starl')); await legacy.waitForNumeric('001');
    legacy.send(`JOIN ${ch}`); await legacy.waitForJoin(ch);
    const modern = await createRawSocketClient(); clients.push(modern);
    await modern.capLs(); await modern.capReq(['away-notify', 'message-tags', 'draft/pre-away']); modern.capEnd();
    modern.register(uniqueNick('starm')); await modern.waitForNumeric('001');
    modern.send(`JOIN ${ch}`); await modern.waitForJoin(ch);

    const p = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('starp'), extraCaps: ['draft/pre-away', 'away-notify'] });
    clients.push(p.client);
    p.client.send(`JOIN ${ch}`); await p.client.waitForJoin(ch);
    await new Promise(r => setTimeout(r, 1000));

    // Lone connection: the star goes out as a star to pre-away, as the word to the rest.
    legacy.clearRawBuffer(); modern.clearRawBuffer();
    p.client.send('AWAY :*');
    const nm = await modern.waitForParsedLine(m => m.command === 'AWAY' && m.source?.nick === p.nick, 5000);
    expect(nm.params[0], nm.raw).toBe('*');
    const nl = await legacy.waitForParsedLine(m => m.command === 'AWAY' && m.source?.nick === p.nick, 5000);
    expect(nl.params[0], nl.raw).toBe('Away');
    modern.clearRawBuffer(); modern.send(`WHOIS ${p.nick}`);
    const wm = await modern.waitForNumeric('301', 5000);
    expect(wm.params[2], wm.raw).toBe('*');
    legacy.clearRawBuffer(); legacy.send(`WHOIS ${p.nick}`);
    const wl = await legacy.waitForNumeric('301', 5000);
    expect(wl.params[2], wl.raw).toBe('Away');
    p.client.send('AWAY');
    await modern.waitForParsedLine(m => m.command === 'AWAY' && m.source?.nick === p.nick && !m.params[0], 5000);

    // A present sibling: the star must not be seen by anyone.
    const a = await createSaslBouncerClient(acc.account, acc.password, { extraCaps: ['draft/pre-away'] });
    clients.push(a.client);
    await new Promise(r => setTimeout(r, 1500));
    const from = { legacy: ((legacy as any).lines as unknown[]).length, modern: ((modern as any).lines as unknown[]).length };
    p.client.send('AWAY :*');
    await new Promise(r => setTimeout(r, 2000));
    legacy.send(`WHOIS ${p.nick}`);
    await legacy.waitForNumeric('318', 5000);
    for (const [who, c, start] of [['legacy', legacy, from.legacy], ['pre-away', modern, from.modern]] as const) {
      const seen = ((c as any).lines as { raw: string }[]).slice(start).map(x => x.raw).filter(x => / AWAY |\b301\b/.test(x) && x.includes(p.nick));
      expect(seen, `${who} saw the star beside a present sibling:\n${seen.join('\n')}`).toEqual([]);
    }
    p.client.send('AWAY');
  }, 60000);
});
