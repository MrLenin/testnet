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
  uniqueId,
} from '../helpers/index.js';

/**
 * Bouncer session echo respects echo-message.
 *
 * A PM sent from one connection of a bouncer session is echoed to the
 * session's other connections so every device sees the conversation.
 * That echo is a message sourced from the user's own nick, which only a
 * client that negotiated `echo-message` knows how to place; a client
 * without it files a PRIVMSG to a non-channel target under its SOURCE,
 * so the user's own outgoing lines showed up in a query window with
 * their own nick (field report 2026-09-15, a three-line paste in a PM).
 * ZNC solved the same thing with an opt-in cap (znc.in/self-message).
 *
 * So: session members without echo-message receive nothing; members with
 * it receive single lines as before and a multiline PM as a batch.
 */

const CAPS = ['batch', 'draft/multiline', 'echo-message', 'message-tags', 'server-time'];
const LINES = ['location ~ ^/filehost/([A-Za-z0-9]+\\.[a-z0-9]+)$ {', '    rewrite ^/filehost/(.+)$ /filehost.php?f=$1 last;', '}'];
const msgLines = (c: RawSocketClient | X3Client) =>
  (((c as any).lines as { raw: string }[]) ?? []).map(x => x.raw).filter(x => /PRIVMSG|BATCH/.test(x) && !/VERSION/.test(x));

describe('bouncer session echo and echo-message', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch { /* */ } try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('a session member without echo-message gets no copy of a PM sent from another device; one with it does', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const p = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('secp'), extraCaps: CAPS });
    clients.push(p.client);
    const legacy = await createSaslBouncerClient(acc.account, acc.password, { extraCaps: [] });
    clients.push(legacy.client);
    const modern = await createSaslBouncerClient(acc.account, acc.password, { extraCaps: CAPS });
    clients.push(modern.client);
    const rcpt = await createRawSocketClient(); clients.push(rcpt);
    await rcpt.capLs(); rcpt.capEnd(); const rn = uniqueNick('secr'); rcpt.register(rn); await rcpt.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 2500));

    // Single line from the primary.
    let legacyBefore = msgLines(legacy.client).length, modernBefore = msgLines(modern.client).length;
    p.client.send(`PRIVMSG ${rn} :single line`);
    await new Promise(r => setTimeout(r, 3000));
    expect(msgLines(legacy.client).slice(legacyBefore), 'legacy member must not receive a self-sourced PM').toEqual([]);
    const modernGot = msgLines(modern.client).slice(modernBefore);
    expect(modernGot.some(l => new RegExp(`PRIVMSG ${rn} :single line$`).test(l)), modernGot.join('\n')).toBe(true);

    // Multiline batch from the primary.
    legacyBefore = msgLines(legacy.client).length; modernBefore = msgLines(modern.client).length;
    const id = `s${uniqueId().slice(0, 6)}`;
    p.client.send(`BATCH +${id} draft/multiline ${rn}`);
    for (const l of LINES) p.client.send(`@batch=${id} PRIVMSG ${rn} :${l}`);
    p.client.send(`BATCH -${id}`);
    await new Promise(r => setTimeout(r, 3000));
    expect(msgLines(legacy.client).slice(legacyBefore), 'legacy member must not receive the flattened multiline echo').toEqual([]);
    const modernMl = msgLines(modern.client).slice(modernBefore);
    expect(modernMl.some(l => /BATCH \+\S+ draft\/multiline/.test(l)), modernMl.join('\n')).toBe(true);
    expect(modernMl.filter(l => new RegExp(`PRIVMSG ${rn} :`).test(l)).length).toBe(3);

    // The recipient saw everything exactly once (unchanged behaviour).
    const seen = msgLines(rcpt).filter(l => new RegExp(`PRIVMSG ${rn} :`).test(l));
    expect(seen.length).toBe(4);
  }, 60000);
});
