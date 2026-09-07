import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueChannel,
  uniqueId,
  uniqueNick,
  waitForChathistory,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
} from '../helpers/index.js';

/**
 * Multi-target msgid index: a QUIT (or NICK) event stores one row per
 * common channel, all under ONE msgid (one-msgid-per-event invariant).
 * The old index keyed on the bare msgid, so channels silently
 * overwrote each other's index row and evicting one channel's copy
 * killed the anchor for the rest.  The index is now keyed
 * "msgid\0target" (per-channel rows, per-channel deletes).
 *
 * This test pins the invariant that the shared msgid is anchorable
 * from EVERY channel the event landed in (AROUND msgid=<quit-msgid>
 * returns results in both channels).  Note: the sharpest breakage of
 * the old scheme (cross-channel anchor kill on per-channel eviction)
 * is eviction-order dependent and not cheaply constructible from a
 * client socket, so this pin is expected green immediately post-fix
 * and guards regressions rather than red-proving the old bug
 * (noted per feedback_no_silent_defer).
 */

describe('multi-channel event msgid anchoring', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  const track = (c: X3Client): X3Client => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  async function mkClient(prefix: string) {
    const c = new X3Client();
    track(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq([
      'batch', 'server-time', 'message-tags',
      'draft/chathistory', 'draft/event-playback',
    ]);
    c.capEnd();
    c.register(uniqueNick(prefix));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 400));
    c.clearRawBuffer();
    const acct = await setupTestAccount(c);
    if (acct.fromPool) poolAccounts.push(acct.account);
    return c;
  }

  it('a QUIT shared across two channels is anchorable from both', async () => {
    const watcher = await mkClient('mcw');
    const quitter = await mkClient('mcq');

    const chanA = uniqueChannel('mcqa');
    const chanB = uniqueChannel('mcqb');
    for (const ch of [chanA, chanB]) {
      watcher.send(`JOIN ${ch}`);
      await watcher.waitForJoin(ch);
      quitter.send(`JOIN ${ch}`);
      await quitter.waitForJoin(ch);
    }
    await new Promise(r => setTimeout(r, 300));

    // Anchor content on each channel so AROUND has neighbors.
    const seedA = uniqueId();
    const seedB = uniqueId();
    watcher.send(`PRIVMSG ${chanA} :seedA ${seedA}`);
    watcher.send(`PRIVMSG ${chanB} :seedB ${seedB}`);
    await new Promise(r => setTimeout(r, 400));

    // The quitter leaves; both channels see ONE QUIT with ONE msgid.
    watcher.clearRawBuffer();
    const quitReason = `bye ${uniqueId()}`;
    quitter.send(`QUIT :${quitReason}`);
    const quitMsg = await watcher.waitForParsedLine(
      m => m.command === 'QUIT' && (m.params[0] ?? '').includes(quitReason),
      5000
    );
    const quitMsgid = quitMsg.tags?.msgid;
    expect(quitMsgid, 'QUIT should carry a msgid tag').toBeTruthy();
    await new Promise(r => setTimeout(r, 500));

    // The shared msgid must anchor an AROUND query in BOTH channels.
    for (const [ch, seed] of [[chanA, seedA], [chanB, seedB]] as const) {
      watcher.clearRawBuffer();
      const messages = await waitForChathistory(watcher, ch, {
        minMessages: 1,
        timeoutMs: 8000,
        subcommand: 'AROUND',
        timestamp: `msgid=${quitMsgid}` as string,
        eventTypes: ['PRIVMSG', 'QUIT'],
      });
      const joined = messages.join('\n');
      expect(
        joined,
        `AROUND msgid=<quit> on ${ch} returned nothing near the anchor — the shared msgid did not resolve for this channel`
      ).toContain(seed);
    }
  });
});
