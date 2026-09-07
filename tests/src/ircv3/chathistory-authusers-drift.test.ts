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
 * authusers-counter drift vs the CHATHISTORY_REQUIRE_AUTH storage gate.
 *
 * With FEAT_CHATHISTORY_REQUIRE_AUTH on, store_channel_history skips
 * storage for a non-+H channel whenever chptr->authusers == 0
 * (ircd_relay.c).  The counter is maintained at membership add/remove
 * (channel.c) by evaluating IsAccount() at THAT moment — so any
 * FLAG_ACCOUNT flip while the client is already a member desyncs it
 * unless the flip site calls channel_account_adjust().
 *
 * This file pins the one drift sequence exercisable end-to-end on the
 * bed: post-connect /REGISTER (draft/account-registration).  Pre-fix:
 *   1. A (authed) joins        -> authusers = 1
 *   2. B (unauthed) joins      -> 1
 *   3. B REGISTERs             -> SetAccount(B), counter NOT bumped (bug)
 *   4. A parts                 -> 0   (B is authed but invisible)
 *   5. B speaks                -> gate sees 0 -> message never stored
 * Post-fix step 3 counts B, step 4 leaves 1, step 5 stores.
 *
 * The sibling drift sites fixed in the same change — post-registration
 * SASL (sasl_auth.c), SVSMODE +r (s_user.c), legacy AC (m_account.c),
 * AC M peer double-count (m_account.c), webhook alias deauth
 * (sasl_webhook.c) — are not independently exercisable from a client
 * connection on this bed (they need a services actor, a legacy-config
 * peer, or a Keycloak webhook event); they share the single
 * channel_account_adjust() chokepoint this test exercises.  Noted per
 * feedback_no_silent_defer.
 *
 * Feature flip follows the chathistory-strict-presence.test.ts pattern:
 * global for the file's duration via oper /SET, reset after.
 */

const REG_PASSWORD = 'driftpw12345';

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('adoper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setRequireAuth(operClient: RawSocketClient, value: boolean): Promise<void> {
  operClient.send(`SET CHATHISTORY_REQUIRE_AUTH ${value ? 'TRUE' : 'FALSE'}`);
  await new Promise(r => setTimeout(r, 300));
}

async function createAuthedClient(): Promise<{ client: X3Client; account: string; fromPool: boolean }> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await client.capLs();
  await client.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
  client.capEnd();
  client.register(uniqueNick('adseed'));
  await client.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 500));
  client.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(client);
  return { client, account, fromPool };
}

/** Best-effort Keycloak cleanup of an account created via REGISTER. */
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
  } catch {
    /* best-effort — a leftover bed account is noise, not failure */
  }
}

describe('authusers drift: post-connect REGISTER vs CHATHISTORY_REQUIRE_AUTH gate', () => {
  const clients: Array<RawSocketClient | X3Client> = [];
  const poolAccounts: string[] = [];
  const createdAccounts: string[] = [];
  let oper: RawSocketClient | null = null;

  const trackClient = <T extends RawSocketClient | X3Client>(c: T): T => {
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    oper = await createOperClient();
    await setRequireAuth(oper, true);
  });

  afterAll(async () => {
    if (oper) {
      try { await setRequireAuth(oper, false); } catch { /* best-effort */ }
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

  it('keeps storing after the last join-time-authed member parts, when a member authed post-join via REGISTER', async () => {
    // A: authed at join time — the only member the counter sees pre-fix.
    const { client: seedA, account, fromPool } = await createAuthedClient();
    trackClient(seedA);
    if (fromPool) poolAccounts.push(account);

    const channel = uniqueChannel('adrift');
    seedA.send(`JOIN ${channel}`);
    await seedA.waitForJoin(channel);

    // B: connects unauthed with account-registration + chathistory caps.
    const clientB = trackClient(await createRawSocketClient());
    await clientB.capLs();
    await clientB.capReq([
      'batch', 'server-time', 'draft/chathistory', 'message-tags',
      'draft/account-registration',
    ]);
    clientB.capEnd();
    clientB.register(uniqueNick('adregb'));
    await clientB.waitForNumeric('001');
    clientB.send(`JOIN ${channel}`);
    await clientB.waitForJoin(channel);

    // Baseline: message while A (counted) is present — must store.
    const preId = uniqueId();
    seedA.send(`PRIVMSG ${channel} :baseline ${preId}`);
    await new Promise(r => setTimeout(r, 400));

    // B registers an account post-connect: FLAG_ACCOUNT flips while B is
    // already a channel member — the drift site under test.
    const acct = `regdrift${uniqueId().slice(0, 6)}`.toLowerCase();
    clientB.send(`REGISTER ${acct} * ${REG_PASSWORD}`);
    const reply = await clientB.waitForParsedLine(
      msg => msg.command === 'REGISTER' && (msg.params[0] === 'SUCCESS' || msg.params[0] === 'FAIL'),
      20000
    );
    expect(reply.params[0], `REGISTER should succeed (got: ${reply.params.join(' ')})`).toBe('SUCCESS');
    createdAccounts.push(acct);
    await new Promise(r => setTimeout(r, 400));

    // A parts. Pre-fix the counter hits 0 here despite B being authed.
    seedA.send(`PART ${channel} :bye`);
    await new Promise(r => setTimeout(r, 500));

    // B speaks. Pre-fix: gate sees authusers==0 -> never stored.
    const postId = uniqueId();
    clientB.send(`PRIVMSG ${channel} :after-part ${postId}`);
    await new Promise(r => setTimeout(r, 400));

    // B (authed) queries history: both messages must be present.
    const messages = await waitForChathistory(clientB, channel, {
      minMessages: 1,
      timeoutMs: 8000,
    });
    const joined = messages.join('\n');
    expect(joined, 'baseline message (stored while a counted member was present) missing').toContain(preId);
    expect(
      joined,
      'post-part message missing: authusers counter lost the REGISTER-authed member (drift) and the REQUIRE_AUTH gate stopped storing'
    ).toContain(postId);
  });
});
