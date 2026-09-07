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
 * Dead-batch line swallowing (client-batch spec: after a FAIL, "all
 * past and future messages in this batch will be ignored").
 *
 * Previously, once a multiline batch died (limit exceeded, bad
 * reftag, timeout), the connection's active-batch state was cleared --
 * and every subsequent `@batch=<dead-ref>` PRIVMSG fell through to
 * NORMAL DELIVERY, spraying the client's half-batch into the channel
 * line by line.  Red on pre-fix binaries.
 */

describe('multiline dead-batch swallowing', () => {
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

  it('lines tagged with a FAILed batch ref are ignored, not delivered', async () => {
    const s = await mk('dbs', [
      'batch', 'server-time', 'message-tags', 'draft/multiline',
    ]);
    const w = await mk('dbw', ['batch', 'server-time', 'message-tags']);

    const channel = uniqueChannel('dbat');
    s.send(`JOIN ${channel}`);
    await s.waitForJoin(channel);
    w.send(`JOIN ${channel}`);
    await w.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    // Kill a batch deliberately: bogus reftag charset triggers
    // FAIL INVALID_REFTAG without ever opening the batch.
    const deadRef = 'bad!ref';
    s.clearRawBuffer();
    s.send(`BATCH +${deadRef} draft/multiline ${channel}`);
    const fail = await s.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'BATCH',
      5000
    );
    expect(fail.params[1]).toBe('INVALID_REFTAG');

    // The client keeps streaming into the dead batch.
    const leakId = uniqueId();
    w.clearRawBuffer();
    s.send(`@batch=${deadRef} PRIVMSG ${channel} :leaked ${leakId}`);
    s.send(`@batch=${deadRef} PRIVMSG ${channel} :leaked2 ${leakId}`);

    // Control message proves the witness pipeline is live.
    const okId = uniqueId();
    s.send(`PRIVMSG ${channel} :control ${okId}`);
    const ctrl = await w.waitForParsedLine(
      m => m.command === 'PRIVMSG' && (m.params[1] ?? '').includes(okId),
      5000
    );
    expect(ctrl).toBeTruthy();

    // The dead-batch lines must never have reached the channel.
    const raw = (w as unknown as { lines?: Array<{ raw: string }> }).lines ?? [];
    const leaked = raw.some(l => l.raw.includes(leakId));
    expect(
      leaked,
      'dead-batch lines were delivered to the channel as ordinary messages'
    ).toBe(false);
  });
});
