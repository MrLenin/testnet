import { describe, it, expect, afterEach } from 'vitest';
import {
  X3Client,
  RawSocketClient,
  IRC_OPER,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  isSecondaryServerAvailable,
  createRawSocketClient,
  createBouncerClient,
  createSaslBouncerClient,
  bouncerInfo,
  bouncerDisableHold,
  getTestAccount,
  releaseTestAccount,
  uniqueNick,
} from '../helpers/index.js';

/**
 * A bouncer session record must never outlive every holder of it.
 *
 * Field case (bed, 2026-09-16, account pool00): a session was held on the
 * hub, the link dropped, the held ghost was KILLed while the leaf could
 * not hear the BS X, and the leaf kept a clientless replica forever: SQUIT
 * only nulled its client pointer, the next link burst re-exported it as
 * "holding", the hub seeded a fresh replica from that, and the pair kept
 * each other alive across restarts.  Convergence then let the older,
 * clientless record win over the live session by session-id order, so a
 * same-account login on the leaf was refused a session (the account
 * "already had one") and registered sessionless under its bnc nick
 * instead of attaching as an alias.
 *
 * Expected after the fix: after the split, the KILL and the relink, a
 * login on the hub gets a session and a login on the leaf attaches to it
 * (adopts the nick, same session id, live=2).
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function operOn(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const c = await createRawSocketClient(server.host, server.port);
  await c.capLs(); c.capEnd();
  c.register(uniqueNick('srop'));
  await c.waitForNumeric('001');
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForNumeric('381', 20000);
  return c;
}

async function splitLeaf(operP: RawSocketClient, operS: RawSocketClient): Promise<void> {
  operP.send('SQUIT leaf.fractalrealities.net :stale replica test');
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    operS.clearRawBuffer(); operS.send('LINKS');
    try { await operS.waitForLine(/testnet\.fractalrealities\.net/i, 1500); }
    catch { return; }
  }
  throw new Error('leaf never registered the split');
}

async function healLeaf(operP: RawSocketClient): Promise<void> {
  operP.send('CONNECT leaf.fractalrealities.net');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    operP.clearRawBuffer(); operP.send('LINKS');
    try { await operP.waitForLine(/leaf\.fractalrealities\.net/i, 1500); await sleep(4000); return; }
    catch { /* */ }
  }
  throw new Error('link did not re-establish after CONNECT');
}

describe('bouncer: a clientless session replica does not outlive its holders', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c as X3Client); } catch { /* */ } try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('after a hold, a split, a KILL of the ghost and a relink, a leaf login attaches to the live hub session', async () => {
    if (!(await isSecondaryServerAvailable())) return;
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const operP = await operOn(PRIMARY_SERVER); clients.push(operP);
    const operS = await operOn(SECONDARY_SERVER); clients.push(operS);

    // 1. A session on the hub, held by an abrupt disconnect.
    const p1 = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('srp') });
    await sleep(2500);                      // BS C reaches the leaf
    (p1.client as any).close();             // no QUIT: the session holds
    await sleep(2500);

    // 2. Link down; the held ghost is KILLed while the leaf cannot hear it.
    await splitLeaf(operP, operS);
    operP.send(`KILL ${p1.nick} :stale replica test`);
    await sleep(2000);
    await healLeaf(operP);

    // 3. Log in on the hub, then on the leaf.  The leaf must attach.
    const p2 = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('srq') });
    clients.push(p2.client);
    await sleep(3000);
    const a = await createSaslBouncerClient(acc.account, acc.password, { host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port });
    clients.push(a.client);
    // The alias adopts the session nick (invariant 2); give the rename a moment.
    for (let i = 0; i < 20 && a.nick !== p2.nick; i++) {
      await sleep(1000);
      try {
        const m = await a.client.waitForParsedLine(x => x.command === 'NICK', 500);
        if (m.params[0]) a.nick = m.params[0];
      } catch { /* */ }
    }
    const infoA = await bouncerInfo(a.client);
    const infoP = await bouncerInfo(p2.client);
    expect(infoA.state, `leaf login has no session (raw: ${infoA.raw})`).toBe('active');
    expect(infoA.sessionId, 'leaf login is not in the hub session').toBe(infoP.sessionId);
    expect(a.nick, 'alias did not adopt the session nick').toBe(p2.nick);
  }, 180000);
});
