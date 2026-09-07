import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  uniqueNick,
  waitForChathistory,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Strict-presence PN replication (#6, metadata-layer replication).
 *
 * When an account's presence interval closes (PART/QUIT), the server
 * broadcasts `PN <account> <channel> <start> <end>`; peers union it
 * into their own account records.  This heals the "roaming" hole: a
 * user whose presence history lives on server A reconnecting via
 * server B previously found B ignorant of every window it had not
 * observed itself — with the strict filter hiding everything.
 *
 * NOTE (red-check finding): while servers are LINKED, presence already
 * replicates by OBSERVATION -- every server's join/part hooks fire for
 * remote users -- so this first test passes even without PN.  It is
 * kept as the pin for that observation-replication property (a
 * regression in the remote-member hooks would break it).  The PN
 * machinery's real work is the second test: a window that closes
 * while the link is DOWN, healed by the burst-time catch-up sync.
 *
 * Flow of the observation test (all windows relative to account U):
 *   on PRIMARY:  W speaks m_pre → U joins → W speaks m_in → U parts
 *                (PN broadcast) → W speaks m_post
 *   on SECONDARY: U (same account) connects, joins, queries.
 * Without replication the secondary knows only U's fresh local open
 * interval → m_in is hidden.  With it, the replicated [join,part]
 * window makes m_in visible while m_pre (before join) and m_post
 * (inside the part→rejoin gap) stay hidden.
 *
 * Requires the linked bed (nefarious + nefarious2), strict presence
 * flipped ON on BOTH servers for the file's duration.
 */

async function createOperOn(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const client = await createRawSocketClient(server.host, server.port);
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('proper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setStrict(oper: RawSocketClient, value: boolean): Promise<void> {
  oper.send(`SET CHATHISTORY_STRICT_PRESENCE ${value ? 'TRUE' : 'FALSE'}`);
  await new Promise(r => setTimeout(r, 300));
}

describe('strict-presence PN replication across servers', () => {
  const clients: Array<RawSocketClient | X3Client> = [];
  const poolAccounts: string[] = [];
  let operPrimary: RawSocketClient | null = null;
  let operSecondary: RawSocketClient | null = null;

  const track = <T extends RawSocketClient | X3Client>(c: T): T => {
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    operPrimary = await createOperOn(PRIMARY_SERVER);
    operSecondary = await createOperOn(SECONDARY_SERVER);
    await setStrict(operPrimary, true);
    await setStrict(operSecondary, true);
  });

  afterAll(async () => {
    for (const [oper] of [[operPrimary], [operSecondary]] as const) {
      if (!oper) continue;
      try { await setStrict(oper, false); } catch { /* */ }
      try { oper.send('QUIT'); } catch { /* */ }
      try { oper.close(); } catch { /* */ }
    }
  });

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('linked observation: primary-era window visible via the secondary', async () => {
    // Witness W: authed, on PRIMARY, stays in the channel throughout.
    const w = new X3Client();
    track(w);
    await w.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await w.capLs();
    await w.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    w.capEnd();
    w.register(uniqueNick('prwit'));
    await w.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    w.clearRawBuffer();
    const wAcct = await setupTestAccount(w);
    if (wAcct.fromPool) poolAccounts.push(wAcct.account);

    const channel = uniqueChannel('prepl');
    w.send(`JOIN ${channel}`);
    await w.waitForJoin(channel);

    const preId = uniqueId();
    w.send(`PRIVMSG ${channel} :pre ${preId}`);
    await new Promise(r => setTimeout(r, 400));

    // U on PRIMARY: authed, joins, witnesses m_in, parts (-> PN).
    const u1 = new X3Client();
    track(u1);
    await u1.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await u1.capLs();
    await u1.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    u1.capEnd();
    u1.register(uniqueNick('prusr'));
    await u1.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    u1.clearRawBuffer();
    const uAcct = await setupTestAccount(u1);
    if (uAcct.fromPool) poolAccounts.push(uAcct.account);

    u1.send(`JOIN ${channel}`);
    await u1.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    const inId = uniqueId();
    w.send(`PRIVMSG ${channel} :inwindow ${inId}`);
    await new Promise(r => setTimeout(r, 400));

    u1.send(`PART ${channel} :moving`);
    // >1s: presence intervals are epoch-second granular with inclusive
    // ends -- a post-part message inside the SAME wall-clock second as
    // the part truncates onto the interval end and is legitimately
    // visible.  The gap assertion needs a clean second boundary.
    await new Promise(r => setTimeout(r, 1400));

    const postId = uniqueId();
    w.send(`PRIVMSG ${channel} :post ${postId}`);
    await new Promise(r => setTimeout(r, 400));

    // Disconnect U's primary connection so the account roams cleanly.
    u1.send('QUIT');
    u1.close();
    await new Promise(r => setTimeout(r, 400));

    // Same account, now via SECONDARY.
    const u2 = new X3Client();
    track(u2);
    await u2.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    await u2.capLs();
    await u2.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    u2.capEnd();
    u2.register(uniqueNick('prusr2'));
    await u2.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    u2.clearRawBuffer();
    const auth = await u2.auth(uAcct.account, uAcct.password, 30000);
    expect(auth.success, `same-account auth on secondary failed: ${auth.error}`).toBe(true);

    u2.send(`JOIN ${channel}`);
    await u2.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 400));

    u2.clearRawBuffer();
    const messages = await waitForChathistory(u2, channel, {
      minMessages: 1,
      timeoutMs: 8000,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'primary-era in-window message hidden on the secondary: the PN close never replicated (or was not applied)'
    ).toContain(inId);
    expect(
      joined,
      'pre-join message leaked: replication must not grant windows before the join'
    ).not.toContain(preId);
    expect(
      joined,
      'gap message leaked: the part->rejoin gap must stay hidden'
    ).not.toContain(postId);
  });

  it('split window heals via burst PN sync: window closed during a netsplit becomes visible after relink', async () => {
    // Witness W on PRIMARY, in the channel for the whole scenario.
    const w = new X3Client();
    track(w);
    await w.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await w.capLs();
    await w.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    w.capEnd();
    w.register(uniqueNick('spwit'));
    await w.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    w.clearRawBuffer();
    const wAcct = await setupTestAccount(w);
    if (wAcct.fromPool) poolAccounts.push(wAcct.account);

    const channel = uniqueChannel('psplit');
    w.send(`JOIN ${channel}`);
    await w.waitForJoin(channel);

    const preId = uniqueId();
    w.send(`PRIVMSG ${channel} :pre ${preId}`);
    await new Promise(r => setTimeout(r, 400));

    // U authed on PRIMARY before the split (auth needs X3, primary side).
    const u1 = new X3Client();
    track(u1);
    await u1.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await u1.capLs();
    await u1.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    u1.capEnd();
    u1.register(uniqueNick('spusr'));
    await u1.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    u1.clearRawBuffer();
    const uAcct = await setupTestAccount(u1);
    if (uAcct.fromPool) poolAccounts.push(uAcct.account);

    // SPLIT the leaf away.  Everything between here and the CONNECT is
    // invisible to the secondary -- including U's whole membership
    // window, whose PN close broadcast is lost mid-split.
    operPrimary!.send('SQUIT leaf.fractalrealities.net :presence split test');

    // Wait until the SECONDARY has actually noticed the link is gone.
    // Its dead-link detection lags the primary's SQUIT; anything it
    // observes before teardown gets a presence interval closed at
    // teardown time -- an inherent, detection-lag-bounded over-grant
    // (documented in the audit doc).  The scenario under test is a
    // window the secondary NEVER observed, so U1 must join only after
    // the far side has dropped the link.
    let splitSeen = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      operSecondary!.clearRawBuffer();
      operSecondary!.send('LINKS');
      try {
        await operSecondary!.waitForLine(/testnet\.fractalrealities\.net/i, 1500);
        // still linked
      } catch {
        splitSeen = true;
        break;
      }
    }
    expect(splitSeen, 'secondary never registered the split (split-detect)').toBe(true);
    await new Promise(r => setTimeout(r, 500));

    u1.send(`JOIN ${channel}`);
    await u1.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    const inId = uniqueId();
    w.send(`PRIVMSG ${channel} :inwindow ${inId}`);
    await new Promise(r => setTimeout(r, 400));

    u1.send(`PART ${channel} :leaving during split`);
    // >1s past the part second (see the observation test's note).
    await new Promise(r => setTimeout(r, 1400));

    const postId = uniqueId();
    w.send(`PRIVMSG ${channel} :post ${postId}`);
    await new Promise(r => setTimeout(r, 300));

    u1.send('QUIT');
    u1.close();
    await new Promise(r => setTimeout(r, 300));

    // HEAL: relink and give the burst (+ presence burst sync) time.
    operPrimary!.send('CONNECT leaf.fractalrealities.net');
    let healed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      operPrimary!.clearRawBuffer();
      operPrimary!.send('LINKS');
      try {
        await operPrimary!.waitForLine(/leaf\.fractalrealities\.net/i, 1500);
        healed = true;
        break;
      } catch { /* not yet */ }
    }
    expect(healed, 'link did not re-establish after CONNECT').toBe(true);
    await new Promise(r => setTimeout(r, 2000));  // burst + PN sync settle

    // Same account via the SECONDARY.  Its local store missed m_in
    // (content arrives via federation at query time); its presence
    // records missed U's window entirely -- only the burst PN sync can
    // supply it.
    const u2 = new X3Client();
    track(u2);
    await u2.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    await u2.capLs();
    await u2.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    u2.capEnd();
    u2.register(uniqueNick('spusr2'));
    await u2.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    u2.clearRawBuffer();
    const auth = await u2.auth(uAcct.account, uAcct.password, 30000);
    expect(auth.success, `same-account auth on secondary failed: ${auth.error}`).toBe(true);

    u2.send(`JOIN ${channel}`);
    await u2.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 400));

    u2.clearRawBuffer();
    const messages = await waitForChathistory(u2, channel, {
      minMessages: 1,
      timeoutMs: 10000,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'split-window message hidden on the secondary: the burst PN sync did not deliver the window closed during the split'
    ).toContain(inId);
    expect(joined, 'pre-join message leaked').not.toContain(preId);
    expect(joined, 'post-part gap message leaked').not.toContain(postId);
  });
});
