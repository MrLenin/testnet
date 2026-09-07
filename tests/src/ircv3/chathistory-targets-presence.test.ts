import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  uniqueNick,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * CHATHISTORY TARGETS strict-presence filter (audit oversight fix).
 *
 * TARGETS previously leaked the last-activity timestamp of channels
 * the requester was a MEMBER of but not PRESENT for — under strict
 * presence a late joiner could not read the messages, but TARGETS
 * still told them when the channel was last active.  The filter now
 * requires presence at the activity time (single funnel in
 * send_targets_batch; +H bypasses; PMs already participant-checked).
 */

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('tgoper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setStrict(oper: RawSocketClient, value: boolean): Promise<void> {
  oper.send(`SET CHATHISTORY_STRICT_PRESENCE ${value ? 'TRUE' : 'FALSE'}`);
  await new Promise(r => setTimeout(r, 300));
}

describe('CHATHISTORY TARGETS strict-presence filter', () => {
  const clients: Array<RawSocketClient | X3Client> = [];
  const poolAccounts: string[] = [];
  let oper: RawSocketClient | null = null;

  const track = <T extends RawSocketClient | X3Client>(c: T): T => {
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    oper = await createOperClient();
    await setStrict(oper, true);
  });

  afterAll(async () => {
    if (oper) {
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

  it('hides channels whose activity predates the requester presence, keeps witnessed ones', async () => {
    const seed = new X3Client();
    track(seed);
    await seed.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await seed.capLs();
    await seed.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    seed.capEnd();
    seed.register(uniqueNick('tgseed'));
    await seed.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 400));
    seed.clearRawBuffer();
    const seedAcct = await setupTestAccount(seed);
    if (seedAcct.fromPool) poolAccounts.push(seedAcct.account);

    const chanHidden = uniqueChannel('tgh');  // activity BEFORE u joins
    const chanSeen = uniqueChannel('tgs');    // activity WHILE u present

    seed.send(`JOIN ${chanHidden}`);
    await seed.waitForJoin(chanHidden);
    seed.send(`JOIN ${chanSeen}`);
    await seed.waitForJoin(chanSeen);

    // Activity in the to-be-hidden channel happens before U exists.
    seed.send(`PRIVMSG ${chanHidden} :early ${uniqueId()}`);
    // Cross a second boundary so the activity ts can't collide with
    // U's join second (1s interval granularity).
    await new Promise(r => setTimeout(r, 1400));

    const u = new X3Client();
    track(u);
    await u.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await u.capLs();
    await u.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    u.capEnd();
    u.register(uniqueNick('tguser'));
    await u.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 400));
    u.clearRawBuffer();
    const uAcct = await setupTestAccount(u);
    if (uAcct.fromPool) poolAccounts.push(uAcct.account);

    const uJoinedAt = Date.now();
    u.send(`JOIN ${chanHidden}`);
    await u.waitForJoin(chanHidden);
    u.send(`JOIN ${chanSeen}`);
    await u.waitForJoin(chanSeen);
    await new Promise(r => setTimeout(r, 1200));

    // Witnessed activity while U is present.
    seed.send(`PRIVMSG ${chanSeen} :witnessed ${uniqueId()}`);
    await new Promise(r => setTimeout(r, 500));

    // U asks for TARGETS over a window covering both activities.
    const t1 = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const t2 = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    u.clearRawBuffer();
    u.send(`CHATHISTORY TARGETS timestamp=${t1} timestamp=${t2} 50`);

    const lines: string[] = [];
    const deadline = Date.now() + 6000;
    let opened = false;
    while (Date.now() < deadline) {
      try {
        const line = await u.waitForLine(/CHATHISTORY TARGETS |draft\/chathistory-targets|BATCH -/i, 2000);
        if (/BATCH \+\S+ draft\/chathistory-targets/i.test(line)) { opened = true; continue; }
        if (/BATCH -/.test(line) && opened) break;
        if (/CHATHISTORY TARGETS /i.test(line)) lines.push(line);
      } catch { break; }
    }
    const joined = lines.join('\n');
    expect(
      joined,
      `witnessed channel missing from TARGETS: ${chanSeen} should be listed (activity within presence)`
    ).toContain(chanSeen);

    // The real property: the PRE-PRESENCE activity time is never
    // revealed.  Because channel events store unconditionally, U's own
    // JOIN bumps chanHidden's last-activity to a time U witnessed --
    // so the row may be listed, but its timestamp must be at/after
    // U's join, never the early message's time.  (With the presence
    // filter, a row whose last activity U did NOT witness is dropped
    // instead -- both outcomes keep the secret timestamp secret.)
    const hiddenLine = lines.find(l => l.includes(chanHidden));
    if (hiddenLine) {
      // Rows now carry a bare ISO timestamp (spec-conformant; the old
      // timestamp= prefix was request syntax leaking into responses).
      const m = hiddenLine.match(/TARGETS \S+ (\d{4}-\d{2}-\d{2}T\S+)/);
      expect(m, `TARGETS row for ${chanHidden} lacks a timestamp`).toBeTruthy();
      const listedTs = Date.parse(m![1]);
      expect(
        listedTs,
        `pre-presence activity time leaked for ${chanHidden}: listed ${m![1]} is before the requester's join (${new Date(uJoinedAt).toISOString()})`
      ).toBeGreaterThanOrEqual(uJoinedAt - 1500); // 1s interval granularity + skew slack
    }
  });
});
