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
  getKeycloakAdminToken,
  PRIMARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Strict-presence anchor transition (2026-08-30 hardening wave).
 *
 * presence_anchor_transfer(): a client who joins a channel UNAUTHED
 * records presence under its session anchor; authenticating
 * mid-membership switches the anchor to the account.  Pre-fix nothing
 * migrated: the account anchor had no interval at all, so the member
 * saw an EMPTY history for a channel they were sitting in (audit
 * finding #4), and the stale session record stayed open forever.
 * Post-fix the open interval's START carries across, so messages from
 * the pre-auth window remain visible and pre-JOIN messages stay hidden.
 *
 * Uses post-connect REGISTER as the transition (same trigger as the
 * authusers drift test).  Feature flip follows the
 * chathistory-strict-presence.test.ts pattern (global for the file).
 */

const REG_PASSWORD = 'presencepw123';

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('spoper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setStrict(oper: RawSocketClient, value: boolean): Promise<void> {
  oper.send(`SET CHATHISTORY_STRICT_PRESENCE ${value ? 'TRUE' : 'FALSE'}`);
  await new Promise(r => setTimeout(r, 300));
}

async function deleteKeycloakAccount(username: string): Promise<void> {
  try {
    const token = await getKeycloakAdminToken();
    const base = `http://${PRIMARY_SERVER.host}:8080/admin/realms/afternet`;
    const res = await fetch(`${base}/users?username=${encodeURIComponent(username)}&exact=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const users = (await res.json()) as Array<{ id: string; username: string }>;
    for (const u of users) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        await fetch(`${base}/users/${u.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  } catch { /* best-effort */ }
}

describe('strict-presence: anchor transition on mid-membership auth', () => {
  const clients: Array<RawSocketClient | X3Client> = [];
  const poolAccounts: string[] = [];
  const createdAccounts: string[] = [];
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
    for (const a of createdAccounts) await deleteKeycloakAccount(a);
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

  it('keeps the pre-auth window visible after REGISTER (open interval transfers to the account anchor)', async () => {
    // Seed A: authed, joins and speaks BEFORE B arrives.
    const seed = new X3Client();
    track(seed);
    await seed.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await seed.capLs();
    await seed.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    seed.capEnd();
    seed.register(uniqueNick('sptra'));
    await seed.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    seed.clearRawBuffer();
    const { account, fromPool } = await setupTestAccount(seed);
    if (fromPool) poolAccounts.push(account);

    const channel = uniqueChannel('sptr');
    seed.send(`JOIN ${channel}`);
    await seed.waitForJoin(channel);

    const preJoinId = uniqueId();
    seed.send(`PRIVMSG ${channel} :prejoin ${preJoinId}`);
    // Presence intervals are second-granular with an inclusive lower
    // edge: if B's JOIN lands in the SAME wall-clock second as this
    // pre-join message, the interval [join_second, ...) covers it and
    // it is (correctly, by that granularity) shown.  Hold long enough
    // that B's join is a clear second later so "before the join" is
    // unambiguous.
    await new Promise(r => setTimeout(r, 1500));

    // B: unauthed, joins, witnesses a message, then REGISTERs.
    const b = track(await createRawSocketClient());
    await b.capLs();
    await b.capReq([
      'batch', 'server-time', 'draft/chathistory', 'message-tags',
      'draft/account-registration',
    ]);
    b.capEnd();
    b.register(uniqueNick('sptrb'));
    await b.waitForNumeric('001');
    b.send(`JOIN ${channel}`);
    await b.waitForJoin(channel);

    const preAuthId = uniqueId();
    seed.send(`PRIVMSG ${channel} :preauth ${preAuthId}`);
    await new Promise(r => setTimeout(r, 400));

    const acct = `sptr${uniqueId().slice(0, 8)}`.toLowerCase();
    b.send(`REGISTER ${acct} * ${REG_PASSWORD}`);
    const reply = await b.waitForParsedLine(
      msg => msg.command === 'REGISTER' && (msg.params[0] === 'SUCCESS' || msg.params[0] === 'FAIL'),
      20000
    );
    expect(reply.params[0], `REGISTER should succeed (${reply.params.join(' ')})`).toBe('SUCCESS');
    createdAccounts.push(acct);
    await new Promise(r => setTimeout(r, 400));

    const postAuthId = uniqueId();
    seed.send(`PRIVMSG ${channel} :postauth ${postAuthId}`);
    await new Promise(r => setTimeout(r, 400));

    // B queries under its NEW account anchor.
    b.clearRawBuffer();
    const messages = await waitForChathistory(b, channel, {
      minMessages: 1,
      timeoutMs: 8000,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'post-auth message hidden: account anchor has no open interval (transition not applied)'
    ).toContain(postAuthId);
    expect(
      joined,
      'pre-auth window hidden: the open interval start did not transfer from the session anchor'
    ).toContain(preAuthId);
    expect(
      joined,
      'pre-JOIN message leaked: strict presence must still hide history from before the join'
    ).not.toContain(preJoinId);
  });
});
