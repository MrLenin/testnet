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
 * Intrinsic msgid time (2026-09 repack): msgids carry their mint time
 * in chars 5..11 (<node_2><logical_3><time_ms_7><counter_2>), so a
 * msgid REFERENCE resolves to a time anchor even when the id was never
 * stored or has aged out of history -- CHATHISTORY AFTER msgid=X
 * degrades to "after X's mint time" instead of an empty batch, and
 * ATTACH cursors survive storage eviction.
 *
 * The test crafts a syntactically-valid, never-stored msgid whose
 * embedded time predates a seeded message and asserts AFTER returns
 * that message.  Red on pre-repack binaries (unknown msgid -> empty).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789[]';

function encode7(ms: number): string {
  let out = '';
  let v = BigInt(ms);
  for (let i = 0; i < 7; i++) {
    out = ALPHABET[Number(v & 63n)] + out;
    v >>= 6n;
  }
  return out;
}

function craftMsgid(ms: number): string {
  return 'Bj' + 'AAB' + encode7(ms) + 'Ac';
}

describe('intrinsic msgid time anchors', () => {
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

  it('AFTER msgid=<never-stored id> anchors at the id embedded time', async () => {
    const c = new X3Client();
    track(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    c.capEnd();
    c.register(uniqueNick('imsg'));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 400));
    c.clearRawBuffer();
    const acct = await setupTestAccount(c);
    if (acct.fromPool) poolAccounts.push(acct.account);

    const channel = uniqueChannel('imsg');
    c.send(`JOIN ${channel}`);
    await c.waitForJoin(channel);

    // Craft an anchor whose embedded time is BEFORE the seed message.
    const anchor = craftMsgid(Date.now() - 5000);

    const seedId = uniqueId();
    c.send(`PRIVMSG ${channel} :seed ${seedId}`);
    await new Promise(r => setTimeout(r, 500));

    c.clearRawBuffer();
    const messages = await waitForChathistory(c, channel, {
      minMessages: 1,
      timeoutMs: 8000,
      subcommand: 'AFTER',
      timestamp: `msgid=${anchor}`,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'seed missing: the never-stored msgid reference did not degrade to its intrinsic time anchor'
    ).toContain(seedId);
  });
});
