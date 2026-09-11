import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import {
  uniqueNick,
  uniqueId,
  X3Client,
  RawSocketClient,
  IRC_OPER,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  createRawSocketClient,
  SECONDARY_SERVER,
  isSecondaryServerAvailable,
} from '../helpers/index.js';

/**
 * draft/webpush attention trigger (plan: webpush-attention-trigger.md).
 *
 * A push goes out only when the account is UNATTENDED: no connection is
 * connected, present (not away) and recently active (spoke within
 * WEBPUSH_IDLE).  Before this the trigger required a HELD session, so an
 * account with any live connection never got a push.
 *
 * Observable: `STATS webpush` "Pushes since boot: N sent" and the
 * "Suppressed since boot: N attended" counters.  The push itself goes to
 * a capture endpoint; whether the bed can reach it is not asserted (no
 * outbound guarantee), the "sent" counter is the contract.
 */

/** A real P-256 point: encryption (ECDH with the subscriber's key) fails
 * on a random 64-byte blob, and a failed encrypt is "not submitted", not
 * "sent". */
function pushKeys(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return `p256dh=${p256dh};auth=${auth}`;
}

async function operUp(): Promise<RawSocketClient> {
  const o = await createRawSocketClient();
  await o.capLs();
  o.capEnd();
  o.register(uniqueNick('wpaop'));
  await o.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await o.waitForNumeric('381', 20000);
  return o;
}

async function statsCounters(o: RawSocketClient): Promise<{ sent: number; attended: number; notSubmitted: number; idleWindow: number }> {
  o.clearRawBuffer();
  o.send('STATS webpush');
  let sent = -1, attended = -1, notSubmitted = -1, idleWindow = -1;
  for (;;) {
    const m = await o.waitForParsedLine(x => x.command === '249' || x.command === '219', 5000);
    if (m.command === '219') break;
    const t = m.params[m.params.length - 1];
    let r = /Pushes since boot: (\d+) sent.* (\d+) not submitted/.exec(t);
    if (r) { sent = parseInt(r[1], 10); notSubmitted = parseInt(r[2], 10); }
    r = /Suppressed since boot: (\d+) attended.*idle window (\d+) s/.exec(t);
    if (r) { attended = parseInt(r[1], 10); idleWindow = parseInt(r[2], 10); }
  }
  expect(sent, 'STATS webpush has no push counters (old build?)').toBeGreaterThanOrEqual(0);
  return { sent, attended, notSubmitted, idleWindow };
}

describe('draft/webpush attention trigger', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends X3Client | RawSocketClient>(c: T): T => { clients.push(c); return c; };
  let oper: RawSocketClient | null = null;
  let endpointOwner: { c: X3Client; endpoint: string } | null = null;

  afterEach(async () => {
    if (endpointOwner) {
      try { endpointOwner.c.send(`WEBPUSH UNREGISTER ${endpointOwner.endpoint}`); } catch { /* */ }
      endpointOwner = null;
      await new Promise(r => setTimeout(r, 300));
    }
    if (oper) {
      try { oper.send('RESET WEBPUSH_IDLE'); oper.send('RESET WEBPUSH_COOLDOWN'); } catch { /* */ }
      await new Promise(r => setTimeout(r, 300));
      oper = null;
    }
    for (const c of clients) {
      try { await bouncerDisableHold(c as X3Client); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a revive pushes nothing for its own welcome, and counts as attending afterwards', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);

    const p = await createBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('wprv'), extraCaps: ['draft/webpush'],
    });
    track(p.client);
    const nick = p.nick;
    await new Promise(r => setTimeout(r, 500));

    const endpoint = `https://webhook.site/${uniqueId()}-revive`;
    p.client.clearRawBuffer();
    p.client.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(
      m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointOwner = { c: p.client, endpoint };

    oper = track(await operUp());
    oper.send('SET WEBPUSH_IDLE 5');
    oper.send('SET WEBPUSH_COOLDOWN 0');
    await new Promise(r => setTimeout(r, 500));

    // Hold the session for a while so the ghost's idle clock is stale.
    p.client.send('QUIT :phone away');
    await new Promise(r => setTimeout(r, 7000));
    const c0 = await statsCounters(oper);

    // Revive: the welcome burst carries server NOTICEs (TLS line, history
    // notice, ...).  None of them may push.
    const back = await createSaslBouncerClient(acc.account, acc.password, {
      nick, extraCaps: ['draft/webpush'],
    });
    track(back.client);
    endpointOwner = { c: back.client, endpoint };
    await new Promise(r => setTimeout(r, 2500));
    const c1 = await statsCounters(oper);
    expect(c1.sent, 'connect-time server notices pushed').toBe(c0.sent);

    // The person just opened a client: a PM right now is attended.
    const sender = await createRawSocketClient();
    track(sender);
    await sender.capLs(); sender.capEnd(); sender.register(uniqueNick('wpsn2'));
    await sender.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    sender.send(`PRIVMSG ${nick} :ping right after revive`);
    await new Promise(r => setTimeout(r, 2000));
    const c2 = await statsCounters(oper);
    expect(c2.sent, 'a freshly revived connection should count as attending').toBe(c1.sent);
    expect(c2.attended).toBeGreaterThan(c1.attended);
  }, 60000);

  it('pushes to an account with live connections once every connection is idle or away, never while one attends', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);

    // Primary with hold, registered for push; a second live connection.
    const p = await createBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('wpat'), extraCaps: ['draft/webpush'],
    });
    track(p.client);
    const nick = p.nick;
    const a = await createSaslBouncerClient(acc.account, acc.password);
    track(a.client);
    await new Promise(r => setTimeout(r, 1000));

    const endpoint = `https://webhook.site/${uniqueId()}-attention`;
    p.client.clearRawBuffer();
    p.client.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(
      m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointOwner = { c: p.client, endpoint };

    oper = track(await operUp());
    oper.send('SET WEBPUSH_IDLE 5');
    oper.send('SET WEBPUSH_COOLDOWN 0');
    await new Promise(r => setTimeout(r, 500));

    const sender = await createRawSocketClient();
    track(sender);
    await sender.capLs(); sender.capEnd(); sender.register(uniqueNick('wpsnd'));
    await sender.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));

    // 1. The alias just spoke: the account is attended -> no push.
    a.client.send(`PRIVMSG ${nick} :self-note, keeps me attending`);
    await new Promise(r => setTimeout(r, 500));
    const c0 = await statsCounters(oper);
    expect(c0.idleWindow, 'SET WEBPUSH_IDLE 5 did not take').toBe(5);
    sender.send(`PRIVMSG ${nick} :ping while attended`);
    await new Promise(r => setTimeout(r, 2000));
    const c1 = await statsCounters(oper);
    expect(c1.sent, 'a push went out while a connection was attending').toBe(c0.sent);
    expect(c1.attended, 'suppression should be counted as attended').toBeGreaterThan(c0.attended);

    // 2. Everyone quiet past the 5 s window -> unattended -> push.
    await new Promise(r => setTimeout(r, 6500));
    sender.send(`PRIVMSG ${nick} :ping while idle`);
    await new Promise(r => setTimeout(r, 2500));
    const c2 = await statsCounters(oper);
    expect(c2.sent, `no push once every connection was idle (not submitted: ${c1.notSubmitted} -> ${c2.notSubmitted})`).toBeGreaterThan(c1.sent);

    // 3. A connection that speaks again but marks itself away does not attend.
    a.client.send('AWAY :lunch');
    await new Promise(r => setTimeout(r, 300));
    a.client.send(`PRIVMSG ${nick} :away but typing`);
    await new Promise(r => setTimeout(r, 500));
    sender.send(`PRIVMSG ${nick} :ping while away`);
    await new Promise(r => setTimeout(r, 2500));
    const c3 = await statsCounters(oper);
    expect(c3.sent, 'an away connection must not block the push').toBeGreaterThan(c2.sent);
    a.client.send('AWAY');
  }, 60000);
  it('AWAY * on a connection hosted by another server does not block the push (per-connection away replicates)', async () => {
    // draft/pre-away: a client that is not looking says `AWAY *` (Seance
    // does on a hidden page).  The push decision runs on the subscription
    // owner's server, so the other server's connection must replicate its
    // own away state (BX U aw=), not just the session's aggregate.
    if (!(await isSecondaryServerAvailable())) return;
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);
    const p = await createBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('wpaw'), extraCaps: ['draft/webpush'],
    });
    track(p.client);
    const nick = p.nick;
    const a = await createSaslBouncerClient(acc.account, acc.password, {
      host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port,
    });
    track(a.client);
    await new Promise(r => setTimeout(r, 1500));
    const endpoint = `https://webhook.site/${uniqueId()}-awaystar`;
    p.client.clearRawBuffer();
    p.client.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(
      m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointOwner = { c: p.client, endpoint };
    oper = track(await operUp());
    oper.send('SET WEBPUSH_IDLE 5');
    oper.send('SET WEBPUSH_COOLDOWN 0');
    await new Promise(r => setTimeout(r, 500));
    const sender = await createRawSocketClient();
    track(sender);
    await sender.capLs(); sender.capEnd(); sender.register(uniqueNick('wpsnd'));
    await sender.waitForNumeric('001');
    // The attach itself counted as activity; let the hub-side primary go idle.
    await new Promise(r => setTimeout(r, 6000));

    // The leaf connection speaks: it attends (spoke inside the window).
    a.client.send(`PRIVMSG ${nick} :hello from the leaf`);
    await new Promise(r => setTimeout(r, 800));
    const c0 = await statsCounters(oper);
    expect(c0.idleWindow, 'SET WEBPUSH_IDLE 5 did not take').toBe(5);
    sender.send(`PRIVMSG ${nick} :ping while the leaf attends`);
    await new Promise(r => setTimeout(r, 1500));
    const c1 = await statsCounters(oper);
    expect(c1.sent, 'pushed while the leaf connection attended').toBe(c0.sent);

    // Spoke a moment ago, then went away for an unspecified reason (the
    // page was hidden): still inside the idle window, so only the
    // replicated AWAY * can release the push.
    a.client.send(`PRIVMSG ${nick} :one more, then I hide`);
    a.client.send('AWAY *');
    await a.client.waitForNumeric('306', 5000);
    await new Promise(r => setTimeout(r, 800));
    sender.send(`PRIVMSG ${nick} :ping while the leaf is AWAY *`);
    await new Promise(r => setTimeout(r, 1500));
    const c2 = await statsCounters(oper);
    expect(c2.sent, 'AWAY * on the leaf must release the push on the hub').toBeGreaterThan(c1.sent);

    // (No "back" phase: a remote connection's activity reaches this server
    // only on a quiet-to-active transition, at most once per 300 s (BX U
    // la=), so after AWAY it reads as idle here whatever it says next.
    // The local-connection case above covers the return to attending.)
  }, 90000);
});
