import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  createBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  disconnectAbruptly,
  reconnectBouncer,
} from '../helpers/index.js';

/**
 * Reproducer for the PM auto-replay target-format bug.
 *
 * On reconnect into an existing bouncer session, the server replays
 * missed PMs from chathistory. The replay code currently uses the
 * canonical storage key (lowerNick:higherNick) as both the BATCH
 * chathistory target AND the per-message PRIVMSG target on every line.
 *
 * Concrete wire output today (with rdrake / vibebot accounts):
 *   :server BATCH +abc chathistory rdrake:vibebot
 *   :vibebot!u@h PRIVMSG rdrake:vibebot :hello
 *   :rdrake!u@h PRIVMSG rdrake:vibebot :reply
 *   :server BATCH -abc
 *
 * IRCv3-strict clients (Goguma) fragment the conversation into
 * separate logical threads; tolerant clients (Igloo) just open a
 * literal `rdrake:vibebot` query tab in addition to the live
 * `vibebot` tab. Either way the user sees fractured PM histories.
 *
 * Per the IRCv3 chathistory spec, the BATCH target is "the same
 * value the client passed to CHATHISTORY for queries" — for PMs
 * that's the OTHER party's nick, not the storage key. And the
 * per-message PRIVMSG target should be the actual recipient at
 * the time of the message (which is always one of the two
 * parties — never their concatenation).
 *
 * This test asserts:
 *   1. BATCH chathistory <target> never contains ':'
 *   2. PRIVMSG <target> ... never contains ':' (excluding channel
 *      targets which can't have ':' in a valid IRC name anyway)
 */
describe('Bouncer PM auto-replay target format', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('BATCH and per-message targets must not contain the storage-key colon separator', async () => {
    // Two SASL accounts: A is the bouncer user (will disconnect/reconnect),
    // B is the conversation partner.
    const aAcc = await getTestAccount();
    if (aAcc.fromPool) poolAccounts.push(aAcc.account);
    const bAcc = await getTestAccount();
    if (bAcc.fromPool) poolAccounts.push(bAcc.account);

    // NOTE: deliberately do NOT request draft/chathistory — the bouncer
    // gates auto-replay-on-reconnect behind the absence of that cap (the
    // assumption being that chathistory-aware clients will pull history
    // themselves on demand).  This test exercises the auto-replay path
    // specifically, so we present as a legacy client.
    const replayCaps = [
      'batch',
      'message-tags',
      'server-time',
      'echo-message',
      'account-tag',
    ];

    // A connects with bouncer hold + chathistory replay caps.
    const aResult = await createBouncerClient(aAcc.account, aAcc.password, {
      extraCaps: replayCaps,
    });
    const aClient = trackClient(aResult.client);
    const aNick = aResult.nick;

    // B connects (no bouncer hold needed — just needs to send PMs to A).
    const bResult = await createSaslBouncerClient(bAcc.account, bAcc.password);
    const bClient = trackClient(bResult.client);
    const bNick = bResult.nick;

    // Exchange PMs both directions so the conversation has content.
    aClient.send(`PRIVMSG ${bNick} :hello from a`);
    bClient.send(`PRIVMSG ${aNick} :hi from b`);
    aClient.send(`PRIVMSG ${bNick} :how are you`);
    bClient.send(`PRIVMSG ${aNick} :doing well`);

    // Let history persist (rocksdb writes are async).
    await new Promise((r) => setTimeout(r, 1500));

    // A disconnects abruptly — bouncer holds the session.
    disconnectAbruptly(aClient);

    // B sends one more PM while A is gone — this is the "missed
    // message" that triggers replay attribution most reliably.
    bClient.send(`PRIVMSG ${aNick} :you missed this one`);
    await new Promise((r) => setTimeout(r, 1500));

    // A reconnects via SASL auto-resume, capturing the replay stream.
    const aReconnect = await reconnectBouncer(aAcc.account, aAcc.password, {
      nick: aNick, // resume with same nick to keep storage keys aligned
      extraCaps: replayCaps,
    });
    const aClient2 = trackClient(aReconnect.client);

    // Wait for the auto-replay batch(es) to land.
    await new Promise((r) => setTimeout(r, 2500));

    // Inspect the raw stream A received during reconnect.
    // RawSocketClient exposes buffered raw lines via the `allLines` getter.
    const allRaw = aClient2.allLines;

    // Filter to just the chathistory BATCH starts and any PRIVMSG lines.
    const chathistoryBatches = allRaw.filter((l) =>
      /BATCH \+\S+ chathistory/i.test(l),
    );
    const pmLines = allRaw.filter((l) => / PRIVMSG /i.test(l));

    // Sanity: replay should have happened at all.
    expect(
      chathistoryBatches.length,
      `expected at least one chathistory BATCH on reconnect (got 0). Last 20 raw lines:\n${allRaw.slice(-20).join('\n')}`,
    ).toBeGreaterThan(0);

    // Assertion 1: every BATCH chathistory target must not contain ':'
    for (const batchLine of chathistoryBatches) {
      const m = batchLine.match(/BATCH \+\S+ chathistory (\S+)/i);
      expect(m, `failed to parse BATCH line: ${batchLine}`).toBeTruthy();
      const target = m![1];
      expect(
        target,
        `BATCH chathistory target "${target}" must not contain ':' (storage key leak). Line: ${batchLine}`,
      ).not.toContain(':');
    }

    // Assertion 2: every PRIVMSG target in the replay stream must not
    // contain ':' (excluding channel targets, which can never legally
    // contain ':' anyway, but skip them defensively).
    for (const pmLine of pmLines) {
      // Match: "[@tags ]:source PRIVMSG <target> [...]"
      const m = pmLine.match(/(?:^|\s):\S+ PRIVMSG (\S+)/);
      if (!m) continue;
      const target = m[1];
      if (target.startsWith('#') || target.startsWith('&')) continue;
      expect(
        target,
        `PRIVMSG target "${target}" must not contain ':' (storage key leak). Line: ${pmLine}`,
      ).not.toContain(':');
    }

    // Cleanup: disable hold so the pool account is reusable.
    await bouncerDisableHold(aClient2);
    aClient2.send('QUIT');
    bClient.send('QUIT');
  });
});
