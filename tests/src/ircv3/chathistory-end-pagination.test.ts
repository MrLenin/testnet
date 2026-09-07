import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueChannel,
  uniqueId,
  uniqueNick,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
} from '../helpers/index.js';

/**
 * draft/chathistory-end completeness = QUERY EXHAUSTION, not emit count.
 *
 * Reply-side filters (redact originals always; REDACT events for
 * clients without the redaction cap; strict presence when on) shrink
 * the emitted count.  Judging completeness on the post-filter count
 * stamped a FULL page as "no more pages", so end-tag-honoring
 * paginators (Seance) stopped early with history remaining -- "it
 * definitely seems to reach an early end" (field report, 2026-09-01).
 *
 * Scenario: m1..m3 in a channel, m3 redacted.  LATEST 2's raw rows are
 * [m3(redacted original), REDACT event] -- both filtered for a querier
 * without the redaction cap -> emitted 0.  The query itself was NOT
 * exhausted (2 raw rows = limit), so the opener must NOT carry
 * draft/chathistory-end; paging BEFORE must surface m1/m2.
 */

describe('chathistory-end pagination completeness', () => {
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

  async function mk(prefix: string, caps: string[]): Promise<X3Client> {
    const c = new X3Client();
    track(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq(caps);
    c.capEnd();
    c.register(uniqueNick(prefix));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 400));
    c.clearRawBuffer();
    const acct = await setupTestAccount(c);
    if (acct.fromPool) poolAccounts.push(acct.account);
    return c;
  }

  it('a page emptied by filters is not stamped final when the query was not exhausted', async () => {
    // Sender: needs the redaction cap to REDACT its own message.
    const s = await mk('ends', [
      'batch', 'server-time', 'message-tags',
      'draft/chathistory', 'draft/message-redaction',
    ]);
    // Querier: NO redaction cap (both the redacted original and the
    // REDACT event get filtered from its replies).
    const q = await mk('endq', [
      'batch', 'server-time', 'message-tags', 'draft/chathistory',
    ]);

    const channel = uniqueChannel('endp');
    s.send(`JOIN ${channel}`);
    await s.waitForJoin(channel);
    q.send(`JOIN ${channel}`);
    await q.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    const id1 = uniqueId();
    const id2 = uniqueId();
    const id3 = uniqueId();
    q.clearRawBuffer();
    s.send(`PRIVMSG ${channel} :m1 ${id1}`);
    s.send(`PRIVMSG ${channel} :m2 ${id2}`);
    s.send(`PRIVMSG ${channel} :m3 ${id3}`);

    // Capture m3's msgid from the querier's delivery.
    const m3 = await q.waitForParsedLine(
      m => m.command === 'PRIVMSG' && (m.params[1] ?? '').includes(id3),
      5000
    );
    const msgid3 = m3.tags?.msgid;
    expect(msgid3, 'm3 must carry a msgid').toBeTruthy();

    s.send(`REDACT ${channel} ${msgid3} :cleanup`);
    await new Promise(r => setTimeout(r, 600));

    // LATEST 2: raw rows = [redacted original, REDACT event]; the
    // querier receives neither.  The opener must NOT claim finality.
    q.clearRawBuffer();
    q.send(`CHATHISTORY LATEST ${channel} * 2`);
    const opener = await q.waitForLine(/BATCH \+\S+ chathistory/i, 6000);
    expect(
      opener.includes('draft/chathistory-end'),
      `filter-emptied page wrongly stamped final (opener: ${opener}) -- paginators stop with m1/m2 unread`
    ).toBe(false);
  });
});
