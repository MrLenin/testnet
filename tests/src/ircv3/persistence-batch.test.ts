import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  disconnectAbruptly,
  reconnectBouncer,
} from '../helpers/index.js';

/**
 * draft/persistence — Phase 2: batch wrapping.
 *
 * Phase 2a: bounce_send_channel_state() emits its JOIN/TOPIC/NAMES
 *          burst inside `BATCH +<ref> draft/persistence ... BATCH -<ref>`
 *          when the client has both `draft/persistence` and `batch`.
 *
 * Phase 2b: replay_start_bouncer() wraps the per-target chathistory
 *          batches inside an outer `BATCH +<ref>
 *          evilnet.github.io/bouncer-replay ... BATCH -<ref>` when
 *          the client has both caps.  Inner chathistory BATCH start
 *          lines carry `@batch=<outer>` for IRCv3 batch nesting.  The
 *          outer batch is suppressed entirely when replay finds no
 *          messages (lazy emission on first inner-batch open).
 */
describe('draft/persistence — Phase 2 batch wrapping', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const track = (c: RawSocketClient): RawSocketClient => {
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const client of clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('wraps channel-state burst in draft/persistence batch on session resume', async () => {
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);
    const nick = uniqueNick('pba');
    const channel = `#pba-${Date.now()}`;

    // First connect: enable hold, join channel.
    const first = await createBouncerClient(account.account, account.password, {
      nick,
      extraCaps: ['batch', 'message-tags', 'server-time', 'draft/persistence'],
    });
    track(first.client);
    first.client.send(`JOIN ${channel}`);
    await first.client.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === channel,
      5_000,
    );
    await new Promise(r => setTimeout(r, 300));

    disconnectAbruptly(first.client);
    await new Promise(r => setTimeout(r, 600));

    // Reconnect: this triggers the channel-state burst.
    const second = await reconnectBouncer(account.account, account.password, {
      nick,
      extraCaps: ['batch', 'message-tags', 'server-time', 'draft/persistence'],
    });
    const c2 = track(second.client);

    // The burst lands shortly after 001/005.  Give it a moment to drain.
    await new Promise(r => setTimeout(r, 1500));

    const raw = c2.allLines;
    const persistenceStart = raw.find(l =>
      /BATCH \+\S+ draft\/persistence(\s|$)/.test(l),
    );
    expect(
      persistenceStart,
      `expected a 'BATCH +<id> draft/persistence' line on resume.  Last 15 lines:\n${raw.slice(-15).join('\n')}`,
    ).toBeTruthy();

    // Extract batch id and confirm there's a matching close.
    const m = persistenceStart!.match(/BATCH \+(\S+) draft\/persistence/);
    expect(m).toBeTruthy();
    const batchId = m![1];
    const persistenceEnd = raw.find(l => new RegExp(`BATCH -${batchId}(\\s|$)`).test(l));
    expect(persistenceEnd).toBeTruthy();

    // JOIN for the rejoined channel should land between start and end and
    // carry the @batch tag.
    const joinLine = raw.find(l =>
      new RegExp(`@batch=${batchId}[;\\s].* JOIN`).test(l)
      || new RegExp(`batch=${batchId}[;\\s].* JOIN`).test(l),
    );
    expect(
      joinLine,
      `expected a JOIN inside the draft/persistence batch.  Lines:\n${raw.join('\n')}`,
    ).toBeTruthy();

    await bouncerDisableHold(c2);
  });

  it('does NOT wrap channel-state burst when draft/persistence not negotiated', async () => {
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);
    const nick = uniqueNick('pbn');
    const channel = `#pbn-${Date.now()}`;

    const first = await createBouncerClient(account.account, account.password, {
      nick,
      extraCaps: ['batch', 'message-tags', 'server-time'],
    });
    track(first.client);
    first.client.send(`JOIN ${channel}`);
    await first.client.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === channel,
      5_000,
    );
    await new Promise(r => setTimeout(r, 300));

    disconnectAbruptly(first.client);
    await new Promise(r => setTimeout(r, 600));

    const second = await reconnectBouncer(account.account, account.password, {
      nick,
      extraCaps: ['batch', 'message-tags', 'server-time'],
    });
    const c2 = track(second.client);
    await new Promise(r => setTimeout(r, 1500));

    const raw = c2.allLines;
    const persistenceStart = raw.find(l =>
      /BATCH \+\S+ draft\/persistence(\s|$)/.test(l),
    );
    expect(
      persistenceStart,
      `expected NO draft/persistence batch when cap not negotiated. Got: ${persistenceStart}`,
    ).toBeFalsy();

    await bouncerDisableHold(c2);
  });

  it('wraps bouncer replay in evilnet.github.io/bouncer-replay outer batch with inner chathistory tagged', async () => {
    const aAcc = await getTestAccount();
    if (aAcc.fromPool) poolAccounts.push(aAcc.account);
    const bAcc = await getTestAccount();
    if (bAcc.fromPool) poolAccounts.push(bAcc.account);

    const replayCaps = [
      'batch',
      'message-tags',
      'server-time',
      'echo-message',
      'account-tag',
      'draft/persistence',
    ];

    const aResult = await createBouncerClient(aAcc.account, aAcc.password, {
      extraCaps: replayCaps,
    });
    const aClient = track(aResult.client);
    const aNick = aResult.nick;

    const bResult = await createSaslBouncerClient(bAcc.account, bAcc.password);
    const bClient = track(bResult.client);
    const bNick = bResult.nick;

    // PM exchange to seed history.
    aClient.send(`PRIVMSG ${bNick} :hello`);
    bClient.send(`PRIVMSG ${aNick} :hi`);
    aClient.send(`PRIVMSG ${bNick} :how are you`);
    bClient.send(`PRIVMSG ${aNick} :doing well`);
    await new Promise(r => setTimeout(r, 1500));

    disconnectAbruptly(aClient);
    bClient.send(`PRIVMSG ${aNick} :one more for the replay buffer`);
    await new Promise(r => setTimeout(r, 1500));

    const aReconnect = await reconnectBouncer(aAcc.account, aAcc.password, {
      nick: aNick,
      extraCaps: replayCaps,
    });
    const aClient2 = track(aReconnect.client);
    await new Promise(r => setTimeout(r, 2500));

    const raw = aClient2.allLines;
    const outerStart = raw.find(l =>
      /BATCH \+\S+ evilnet\.github\.io\/bouncer-replay(\s|$)/.test(l),
    );
    expect(
      outerStart,
      `expected an outer 'BATCH +<id> evilnet.github.io/bouncer-replay' on resume.  Last 25 lines:\n${raw.slice(-25).join('\n')}`,
    ).toBeTruthy();

    const m = outerStart!.match(/BATCH \+(\S+) evilnet\.github\.io\/bouncer-replay/);
    const outerId = m![1];
    const outerEnd = raw.find(l => new RegExp(`BATCH -${outerId}(\\s|$)`).test(l));
    expect(outerEnd).toBeTruthy();

    // Inner chathistory BATCH lines must carry @batch=<outerId>.
    const innerBatches = raw.filter(l =>
      /BATCH \+\S+ chathistory/.test(l),
    );
    expect(innerBatches.length).toBeGreaterThan(0);
    for (const inner of innerBatches) {
      expect(
        inner,
        `inner chathistory BATCH start should carry @batch=${outerId}: ${inner}`,
      ).toMatch(new RegExp(`batch=${outerId}\\b`));
    }

    await bouncerDisableHold(aClient2);
  });

  it('suppresses outer bouncer-replay batch when nothing to replay', async () => {
    // Fresh pool account: no history, so replay finds nothing.
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);
    const nick = uniqueNick('pbs');

    const replayCaps = [
      'batch',
      'message-tags',
      'server-time',
      'echo-message',
      'account-tag',
      'draft/persistence',
    ];

    const first = await createBouncerClient(account.account, account.password, {
      nick,
      extraCaps: replayCaps,
    });
    track(first.client);
    await new Promise(r => setTimeout(r, 300));

    disconnectAbruptly(first.client);
    await new Promise(r => setTimeout(r, 600));

    // Reconnect without any new traffic — replay should find no messages
    // and skip the outer batch entirely.
    const second = await reconnectBouncer(account.account, account.password, {
      nick,
      extraCaps: replayCaps,
    });
    const c2 = track(second.client);
    await new Promise(r => setTimeout(r, 2000));

    const raw = c2.allLines;
    const outerStart = raw.find(l =>
      /BATCH \+\S+ evilnet\.github\.io\/bouncer-replay(\s|$)/.test(l),
    );
    expect(
      outerStart,
      `expected NO outer bouncer-replay batch when replay finds nothing. Got: ${outerStart}`,
    ).toBeFalsy();

    await bouncerDisableHold(c2);
  });
});
