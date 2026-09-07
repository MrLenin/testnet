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
 * Federation gap fixes:
 *  - BETWEEN never federated (CH Q had one ref slot; the W subcommand
 *    now carries an optional trailing second ref) — ruled bug/oversight.
 *  - PM (pair-key) targets never federated — deferred until history
 *    matured, then forgotten.  The ORIGIN server participant-checks the
 *    requester (check_history_access); responders trust linked servers
 *    per the P10 model.
 *
 * Discriminating content uses the netsplit pattern proven by the PN
 * replication tests: what is said while the leaf is split exists only
 * on the primary, so a later query via the SECONDARY can only see it
 * through federation.
 */

async function createOperOn(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const client = await createRawSocketClient(server.host, server.port);
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('fboper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function mkAuthed(server: typeof PRIMARY_SERVER, prefix: string): Promise<{
  c: X3Client; account: string; password: string; fromPool: boolean; nick: string;
}> {
  const c = new X3Client();
  await c.connect(server.host, server.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
  c.capEnd();
  const nick = uniqueNick(prefix);
  c.register(nick);
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 400));
  c.clearRawBuffer();
  const { account, password, fromPool } = await setupTestAccount(c);
  return { c, account, password, fromPool, nick };
}

async function splitLeaf(operPrimary: RawSocketClient, operSecondary: RawSocketClient,
                         reason: string): Promise<void> {
  operPrimary.send(`SQUIT leaf.fractalrealities.net :${reason}`);
  let splitSeen = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    operSecondary.clearRawBuffer();
    operSecondary.send('LINKS');
    try {
      await operSecondary.waitForLine(/testnet\.fractalrealities\.net/i, 1500);
    } catch { splitSeen = true; break; }
  }
  expect(splitSeen, 'secondary never registered the split').toBe(true);
}

async function healLeaf(operPrimary: RawSocketClient): Promise<void> {
  operPrimary.send('CONNECT leaf.fractalrealities.net');
  let healed = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    operPrimary.clearRawBuffer();
    operPrimary.send('LINKS');
    try {
      await operPrimary.waitForLine(/leaf\.fractalrealities\.net/i, 1500);
      healed = true;
      break;
    } catch { /* */ }
  }
  expect(healed, 'link did not re-establish after CONNECT').toBe(true);
  await new Promise(r => setTimeout(r, 2000));
}

async function roamTo(server: typeof SECONDARY_SERVER, prefix: string,
                      account: string, password: string,
                      track: (c: X3Client) => X3Client): Promise<X3Client> {
  const c = new X3Client();
  track(c);
  await c.connect(server.host, server.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 400));
  c.clearRawBuffer();
  const auth = await c.auth(account, password, 30000);
  expect(auth.success, `same-account auth on secondary failed: ${auth.error}`).toBe(true);
  return c;
}

describe('federated BETWEEN and PM chathistory', () => {
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
  });

  afterAll(async () => {
    for (const oper of [operPrimary, operSecondary]) {
      if (!oper) continue;
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

  it('split-only channel window is retrievable cross-server via BETWEEN', async () => {
    const w = await mkAuthed(PRIMARY_SERVER, 'fbwit');
    track(w.c); if (w.fromPool) poolAccounts.push(w.account);
    const u = await mkAuthed(PRIMARY_SERVER, 'fbusr');
    track(u.c); if (u.fromPool) poolAccounts.push(u.account);

    const channel = uniqueChannel('fbet');
    w.c.send(`JOIN ${channel}`);
    await w.c.waitForJoin(channel);
    u.c.send(`JOIN ${channel}`);
    await u.c.waitForJoin(channel);

    const tStart = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, '.000Z');
    await splitLeaf(operPrimary!, operSecondary!, 'fed between test');

    const chanId = uniqueId();
    w.c.send(`PRIVMSG ${channel} :chansplit ${chanId}`);
    await new Promise(r => setTimeout(r, 500));
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    await healLeaf(operPrimary!);

    const u2 = await roamTo(SECONDARY_SERVER, 'fbusr2', u.account, u.password, track);
    u2.send(`JOIN ${channel}`);
    await u2.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 400));

    // The split-only message exists only on the primary; the secondary
    // can satisfy this BETWEEN only via W federation.
    u2.clearRawBuffer();
    const messages = await waitForChathistory(u2, channel, {
      minMessages: 1,
      timeoutMs: 12000,
      subcommand: 'BETWEEN',
      timestamp: tStart,
      timestamp2: tEnd,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'split-only channel message missing via BETWEEN on the secondary: W federation did not fetch it'
    ).toContain(chanId);
  });

  it('split-only DM is retrievable cross-server (PM federation)', async () => {
    const a = await mkAuthed(PRIMARY_SERVER, 'fpma');
    track(a.c); if (a.fromPool) poolAccounts.push(a.account);
    const b = await mkAuthed(PRIMARY_SERVER, 'fpmb');
    track(b.c); if (b.fromPool) poolAccounts.push(b.account);

    await splitLeaf(operPrimary!, operSecondary!, 'fed pm test');

    // A DMs B during the split — the pair-key rows land only on the
    // primary's store.
    const dmId = uniqueId();
    a.c.send(`PRIVMSG ${b.nick} :dmsplit ${dmId}`);
    await b.c.waitForParsedLine(
      m => m.command === 'PRIVMSG' && (m.params[1] ?? '').includes(dmId),
      5000
    );
    await new Promise(r => setTimeout(r, 400));

    await healLeaf(operPrimary!);

    // B roams to the secondary and queries the DM buffer with A.
    const b2 = await roamTo(SECONDARY_SERVER, 'fpmb2', b.account, b.password, track);
    b2.clearRawBuffer();
    const messages = await waitForChathistory(b2, a.nick, {
      minMessages: 1,
      timeoutMs: 12000,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'split-only DM missing on the secondary: PM federation did not fetch the pair-key rows'
    ).toContain(dmId);
  });
});
