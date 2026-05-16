import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * On-demand CHATHISTORY LATEST <pm-target> must not leak the storage
 * key (lowerNick:higherNick) into either the BATCH chathistory tag
 * or any per-message PRIVMSG target.
 *
 * The bouncer auto-replay path was fixed in nefarious 77a81fe.  The
 * on-demand CHATHISTORY query path went through a different code
 * site (`replay_start_batch`) that blindly used the caller's
 * normalized storage key as `rs->target`, leaking it onto the wire.
 * Fixed in 3db4449 by extracting `replay_set_target_from_storage`
 * and calling it from both paths.
 *
 * Symptom this test guards against (pre-fix wire output):
 *   :server BATCH +abc chathistory <a>:<b>
 *   :<b>!u@h PRIVMSG <a>:<b> :hi
 *   :<a>!u@h PRIVMSG <a>:<b> :reply
 *   :server BATCH -abc
 *
 * IRCv3-strict clients (Goguma) fragment the conversation; tolerant
 * clients (Igloo) open a literal `<a>:<b>` query tab.  Either way the
 * user sees fractured PM history.
 */
describe('CHATHISTORY LATEST on PM target — no storage-key leak', () => {
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

  it('BATCH and per-message targets are the other party\'s nick, not nick:nick', async () => {
    const aAcc = await getTestAccount();
    if (aAcc.fromPool) poolAccounts.push(aAcc.account);
    const bAcc = await getTestAccount();
    if (bAcc.fromPool) poolAccounts.push(bAcc.account);

    // Use a stable nick for B so the test target is predictable.
    const bNick = uniqueNick('histb');

    // A requests draft/chathistory + adjacent caps so the explicit
    // CHATHISTORY LATEST command is honored.  No bouncer hold needed —
    // this test is about the on-demand query path, not auto-replay.
    const queryCaps = [
      'batch',
      'message-tags',
      'server-time',
      'draft/chathistory',
      'echo-message',
    ];

    const aResult = await createSaslBouncerClient(aAcc.account, aAcc.password, {
      extraCaps: queryCaps,
    });
    clients.push(aResult.client);
    const aNick = aResult.nick;

    const bResult = await createSaslBouncerClient(bAcc.account, bAcc.password, {
      nick: bNick,
    });
    clients.push(bResult.client);

    // Exchange a couple of PMs both directions so storage has content.
    bResult.client.send(`PRIVMSG ${aNick} :hi from b`);
    aResult.client.send(`PRIVMSG ${bNick} :reply from a`);
    bResult.client.send(`PRIVMSG ${aNick} :and another`);
    aResult.client.send(`PRIVMSG ${bNick} :ack`);

    // Let rocksdb flush.
    await new Promise(r => setTimeout(r, 1500));

    // A queries history for the conversation with B.
    aResult.client.clearRawBuffer();
    aResult.client.send(`CHATHISTORY LATEST ${bNick} * 20`);

    // Wait for the closing BATCH -<id>.
    await aResult.client.waitForLine(/\bBATCH -\S+/, 5000);

    const raw = aResult.client.allLines;
    const batchStarts = raw.filter(l => /BATCH \+\S+ chathistory/i.test(l));
    const pmLines = raw.filter(l => / PRIVMSG /i.test(l));

    expect(batchStarts.length).toBeGreaterThan(0);

    // Assertion 1: every BATCH chathistory target must equal the other
    // party's nick — definitely no ':' in the target field.
    for (const batchLine of batchStarts) {
      const m = batchLine.match(/BATCH \+\S+ chathistory (\S+)/i);
      expect(m, `failed to parse BATCH line: ${batchLine}`).toBeTruthy();
      const target = m![1];
      expect(
        target,
        `BATCH target "${target}" must not contain ':' (storage-key leak). Line: ${batchLine}`,
      ).not.toContain(':');
      expect(target.toLowerCase()).toBe(bNick.toLowerCase());
    }

    // Assertion 2: every PRIVMSG target in the response must be one of
    // the two party nicks — never their concatenation.
    for (const pmLine of pmLines) {
      const m = pmLine.match(/(?:^|\s):\S+ PRIVMSG (\S+)/);
      if (!m) continue;
      const target = m[1];
      if (target.startsWith('#') || target.startsWith('&')) continue;
      expect(
        target,
        `PRIVMSG target "${target}" must not contain ':' (storage-key leak). Line: ${pmLine}`,
      ).not.toContain(':');
      // Should be aNick (incoming) or bNick (outgoing).
      const lower = target.toLowerCase();
      expect([aNick.toLowerCase(), bNick.toLowerCase()]).toContain(lower);
    }
  });
});
