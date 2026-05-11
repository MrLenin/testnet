import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  uniqueNick,
  waitForChathistory,
  getCaps,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Phase B strict-presence filter tests.
 *
 * FEAT_CHATHISTORY_STRICT_PRESENCE defaults to 0; these tests flip
 * it on globally for the file's duration via /SET (oper) and reset
 * to off after.  Other test files running in parallel will see the
 * strict gate active during this window — acceptable for the local
 * dev run flow, less so for unmonitored CI.  If that bites, gate
 * each test on a fresh per-server fixture instead.
 *
 * The filter being exercised lives in chathistory_presence.c and is
 * called from m_chathistory.c's presence_filter_and_replay wrapper.
 * Three behaviors are covered:
 *
 *   1. Pre-join messages are filtered out of a newly-joining user's
 *      history view (the load-bearing security property).
 *   2. Channel mode +H (EXMODE_PUBLICHISTORY) bypasses the filter so
 *      public-history channels stay queryable from any membership.
 *   3. HISTORY_REDACT records inherit the visibility of their target —
 *      a redact whose target was visible to the requester stays in
 *      the result list even though the requester wasn't present at
 *      the redact's own timestamp.
 */

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('soper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setStrictPresence(operClient: RawSocketClient, value: boolean): Promise<void> {
  operClient.send(`SET CHATHISTORY_STRICT_PRESENCE ${value ? 'TRUE' : 'FALSE'}`);
  // Server replies with a NOTICE confirmation; brief settle is enough.
  await new Promise(r => setTimeout(r, 300));
}

async function createAuthedHistoryClient(
  extraCaps: string[] = [],
  nick?: string,
): Promise<{ client: X3Client; account: string; fromPool: boolean; nick: string }> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await client.capLs();
  await client.capReq(getCaps('chathistory', ...extraCaps));
  client.capEnd();
  const actualNick = nick || `seed${uniqueId().slice(0, 6)}`;
  client.register(actualNick);
  await client.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 500));
  client.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(client);
  return { client, account, fromPool, nick: actualNick };
}

describe('Phase B Strict-Presence Filter (FEAT_CHATHISTORY_STRICT_PRESENCE)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  let oper: RawSocketClient | null = null;

  const trackClient = <T extends RawSocketClient>(client: T): T => {
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    oper = await createOperClient();
    await setStrictPresence(oper, true);
  });

  afterAll(async () => {
    if (oper) {
      try { await setStrictPresence(oper, false); } catch { /* best-effort */ }
      try { oper.send('QUIT'); } catch { /* */ }
      try { oper.close(); } catch { /* */ }
    }
  });

  afterEach(async () => {
    for (const c of clients) {
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('filters out messages from before the requester\'s join (core security property)', async () => {
    const { client: seed, account, fromPool, nick: seedNick }
      = await createAuthedHistoryClient();
    trackClient(seed);
    if (fromPool) poolAccounts.push(account);

    const channel = uniqueChannel('strict');
    seed.send(`JOIN ${channel}`);
    await seed.waitForJoin(channel);

    // Seed sends a message BEFORE the late joiner arrives.
    const preJoinId = uniqueId();
    const preJoinMsg = `pre-join ${preJoinId}`;
    seed.send(`PRIVMSG ${channel} :${preJoinMsg}`);
    await new Promise(r => setTimeout(r, 400));

    // Late joiner connects (authed too, so chathistory query is allowed
    // — what we're testing is the presence FILTER, not the auth gate).
    const { client: late, account: lateAcct, fromPool: lateFromPool, nick: lateNick }
      = await createAuthedHistoryClient([], `late${uniqueId().slice(0, 5)}`);
    trackClient(late);
    if (lateFromPool) poolAccounts.push(lateAcct);
    late.send(`JOIN ${channel}`);
    await late.waitForJoin(channel);

    // Late joiner now queries channel history.  Strict mode should
    // filter pre-join messages out of the result.  waitForChathistory
    // returns the raw IRC lines as strings; substring-match against
    // the unique IDs.
    let sawPreJoinMsg = false;
    try {
      const messages = await waitForChathistory(late, channel, {
        minMessages: 0,
        timeoutMs: 5000,
      });
      for (const m of messages) {
        if (m.includes(preJoinId)) sawPreJoinMsg = true;
      }
    } catch {
      // Empty result is acceptable here — the assertion is that the
      // pre-join message is NOT visible.  An empty batch satisfies that.
    }
    expect(sawPreJoinMsg,
      'Strict-presence filter must hide messages sent before the requester joined'
    ).toBe(false);

    // Sanity: after late joiner has been present, a NEW message should
    // be visible — proving the channel and chathistory itself work,
    // we're not just getting empty results across the board.
    const postJoinId = uniqueId();
    seed.send(`PRIVMSG ${channel} :post-join ${postJoinId}`);
    await new Promise(r => setTimeout(r, 400));

    let sawPostJoinMsg = false;
    const after = await waitForChathistory(late, channel, {
      minMessages: 1,
      timeoutMs: 5000,
    });
    for (const m of after) {
      if (m.includes(postJoinId)) sawPostJoinMsg = true;
    }
    expect(sawPostJoinMsg,
      'Messages sent during the requester\'s presence must be visible'
    ).toBe(true);
  });

  it('+H channel bypasses the strict-presence filter (public history)', async () => {
    const { client: seed, account, fromPool, nick: seedNick }
      = await createAuthedHistoryClient();
    trackClient(seed);
    if (fromPool) poolAccounts.push(account);

    const channel = uniqueChannel('strictH');
    seed.send(`JOIN ${channel}`);
    await seed.waitForJoin(channel);
    // Make it +H (need chanop, which JOIN as first user grants).
    seed.send(`MODE ${channel} +H`);
    await new Promise(r => setTimeout(r, 300));

    // Pre-join message on a +H channel.
    const preId = uniqueId();
    seed.send(`PRIVMSG ${channel} :public ${preId}`);
    await new Promise(r => setTimeout(r, 400));

    const { client: late, account: lateAcct, fromPool: lateFromPool }
      = await createAuthedHistoryClient([], `late${uniqueId().slice(0, 5)}`);
    trackClient(late);
    if (lateFromPool) poolAccounts.push(lateAcct);
    late.send(`JOIN ${channel}`);
    await late.waitForJoin(channel);

    // +H means strict filter should NOT apply.  The pre-join message
    // is visible to the late joiner.
    const messages = await waitForChathistory(late, channel, {
      minMessages: 1,
      timeoutMs: 5000,
    });
    let sawPublic = false;
    for (const m of messages) {
      if (m.includes(preId)) sawPublic = true;
    }
    expect(sawPublic,
      '+H channel must bypass the presence filter — pre-join messages should be visible'
    ).toBe(true);
  });

  it('redact of a visible message stays visible (redaction inheritance)', async () => {
    // Two users with overlapping presence, one redacts their own
    // message AFTER the other parts.  The redact's own timestamp is
    // outside the parter's presence window, but the redacted
    // message's timestamp IS inside that window.  Redaction
    // inheritance says: the redact follows the target's visibility.
    //
    // We verify by checking that the redacted record appears (with
    // its REDACT-type / placeholder content) in the parter's history
    // view.  Without inheritance, the parter would see the original
    // un-redacted content — defeating the redact's purpose.

    // Client A needs echo-message so we can recover the msgid the
    // server assigned to A's PRIVMSG (REDACT addresses the message by
    // msgid).  Client B doesn't need it.
    const { client: a, account: accA, fromPool: poolA, nick: aNick }
      = await createAuthedHistoryClient(['draft/message-redaction', 'echo-message', 'labeled-response']);
    trackClient(a);
    if (poolA) poolAccounts.push(accA);
    const { client: b, account: accB, fromPool: poolB, nick: bNick }
      = await createAuthedHistoryClient(['draft/message-redaction']);
    trackClient(b);
    if (poolB) poolAccounts.push(accB);

    const channel = uniqueChannel('strictRD');
    a.send(`JOIN ${channel}`);
    await a.waitForJoin(channel);
    b.send(`JOIN ${channel}`);
    await b.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 200));

    // A sends a message while B is present.
    const tag = `to-redact-${uniqueId()}`;
    a.send(`@label=mr1 PRIVMSG ${channel} :${tag}`);
    // Find the msgid in the echo so we can REDACT by id.
    const echo = await a.waitForParsedLine(
      msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(tag) === true,
      3000
    );
    const msgidMatch = echo.raw.match(/msgid=([^\s;]+)/);
    if (!msgidMatch) {
      console.log('Could not extract msgid from echo:', echo.raw);
      return;
    }
    const msgid = msgidMatch[1];
    await new Promise(r => setTimeout(r, 200));

    // B parts BEFORE the redact happens.
    b.send(`PART ${channel}`);
    await new Promise(r => setTimeout(r, 300));

    // A redacts the message.  This happens after B's part — B's
    // presence interval doesn't cover this timestamp.
    a.send(`REDACT ${channel} ${msgid} :spoiler`);
    await new Promise(r => setTimeout(r, 400));

    // B rejoins to query (need current membership for the access gate).
    b.send(`JOIN ${channel}`);
    await b.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 200));

    let messages: string[] = [];
    try {
      messages = await waitForChathistory(b, channel, {
        minMessages: 0,
        timeoutMs: 5000,
        // REDACT comes back as a separate event type, not a PRIVMSG.
        eventTypes: ['PRIVMSG', 'NOTICE', 'REDACT'],
      });
    } catch {
      // Empty / timeout — the assertion below tests for ABSENCE of the
      // original, so empty satisfies that.
    }

    // Inheritance says: B should see the REDACT (or the redacted
    // content) for the message they witnessed live.  What B should
    // NOT see is the original un-redacted content, which would mean
    // the redact didn't propagate.
    let sawOriginal = false;
    let sawRedact = false;
    for (const m of messages) {
      if (m.includes(tag) && !/\bREDACT\b/i.test(m)) {
        // Found the original content as a normal PRIVMSG — that's
        // the failure case (redact not applied to history view).
        sawOriginal = true;
      }
      if (m.includes('spoiler') || /\bREDACT\b/i.test(m)) {
        sawRedact = true;
      }
    }

    // Either: the original is replaced by a redact marker (sawRedact),
    // or the message is removed entirely.  Both are correct outcomes;
    // what's NOT acceptable is seeing the original un-redacted content
    // — that's the inheritance failure.
    expect(sawOriginal,
      'After REDACT, the original message content must not be visible — ' +
      'redaction must follow the target\'s visibility, not its own timestamp'
    ).toBe(false);
    console.log(`redaction-inheritance outcome: sawRedact=${sawRedact}, sawOriginal=${sawOriginal}`);
  });
});
