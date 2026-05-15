import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  uniqueChannel,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  disconnectAbruptly,
  createRawSocketClient,
} from '../helpers/index.js';

/**
 * Channel-membership persistence across HOLD / revive.
 *
 * Design invariant (bouncer-design-intent.md §Session lifecycle, plus
 * bouncer_session.c::SetMemberHolding): when the primary of a bouncer
 * session abruptly disconnects, the session transitions to HOLDING and
 * the dying Client becomes a ghost (IsBouncerHold).  The ghost stays in
 * channel rosters as a "held member" so observers continue to see the
 * user in the channel, and so that on revive the user does not need to
 * rejoin.
 *
 * Concretely:
 *   1. Bouncer user joins #chan, observer in same channel sees the JOIN.
 *   2. Bouncer user abruptly disconnects — session → HOLDING.
 *   3. Observer sees no PART/QUIT for the bouncer user (held membership).
 *   4. Bouncer user reconnects with SASL → bounce_revive transplants the
 *      new socket onto the ghost.  Observer receives no second JOIN
 *      (the user never left).
 *   5. Revived user can PRIVMSG into the channel and the observer
 *      receives it — proving the membership survived and the channel
 *      route is intact.
 */
describe('Bouncer channel membership across HOLD / revive', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('ghost stays in channel during HOLD and is intact after revive', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const target = uniqueNick('chp');
    const channel = uniqueChannel('chp');

    // Bouncer user.
    const { client: bouncer } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(bouncer);
    expect(await bouncerEnableHold(bouncer)).toBe(true);

    // Observer (plain client).
    const observer = await createRawSocketClient();
    clients.push(observer);
    await observer.capLs();
    observer.capEnd();
    observer.register(uniqueNick('obs'));
    await observer.waitForNumeric('001');

    // Observer joins channel first.
    observer.send(`JOIN ${channel}`);
    await observer.waitForJoin(channel);

    // Bouncer joins; observer sees JOIN.  Use a relaxed regex — JOIN may
    // arrive with or without a leading ':' on the channel param, and the
    // userhost format varies depending on cap negotiation.
    observer.clearRawBuffer();
    bouncer.send(`JOIN ${channel}`);
    const channelEscaped = channel.replace('#', '\\#');
    await observer.waitForLine(
      new RegExp(`:${target}\\b[^ ]* JOIN :?${channelEscaped}`),
      5000,
    );

    // Abrupt disconnect: TCP RST → session HOLDING; ghost stays hashed
    // and held-in-channel.
    observer.clearRawBuffer();
    disconnectAbruptly(bouncer);
    const idx = clients.indexOf(bouncer);
    if (idx >= 0) clients.splice(idx, 1);

    // Give bouncer time to detect dead socket and transition.
    await new Promise(r => setTimeout(r, 1500));

    // Observer should NOT have seen a PART or QUIT for target — held
    // ghosts do not emit either.  Scan unconsumed lines to confirm.
    const buf = observer.getUnconsumedLines().join('\n');
    expect(buf).not.toMatch(new RegExp(`:${target}![^ ]+ PART `));
    expect(buf).not.toMatch(new RegExp(`:${target}![^ ]+ QUIT`));

    // Revive: reconnect with SASL on the same account + nick.
    observer.clearRawBuffer();
    const { client: revived } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(revived);

    // Settle bouncer revive.
    await new Promise(r => setTimeout(r, 500));

    // Observer should NOT have seen a fresh JOIN for target (the
    // membership persisted through the HOLDING ghost).
    const buf2 = observer.getUnconsumedLines().join('\n');
    expect(buf2).not.toMatch(new RegExp(`:${target}\\b[^ ]* JOIN :?${channelEscaped}`));

    // Revived client PRIVMSGs into the channel — observer receives it.
    // This proves the held channel route survived intact.
    observer.clearRawBuffer();
    revived.send(`PRIVMSG ${channel} :hello after revive`);
    const msg = await observer.waitForLine(
      new RegExp(`:${target}\\b[^ ]* PRIVMSG ${channelEscaped} :hello after revive`),
      5000,
    );
    expect(msg).toContain('hello after revive');
  });
});
