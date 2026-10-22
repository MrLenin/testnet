import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  createRawSocketClient,
  SECONDARY_SERVER,
  IRC_OPER,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import {
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  disconnectAbruptly,
} from '../helpers/bouncer.js';

/**
 * A bouncer session's active time reaches the other servers (BX U ta=).
 *
 * The earned hold adds an hour per 24 h attached.  The figure lived only on
 * the server holding the session; a replica learned it once, from the BS C
 * that created it, so a server that became the holder by a promotion or a
 * move armed the hold from a stale figure (deferred-items B3).  The leaf's
 * CHECK -b now shows the active time it knows ("Active time:: Ns").
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The "Active time" CHECK -b reports for @a nick on @a op's server. */
async function activeTime(op: RawSocketClient, nick: string): Promise<number | null> {
  const mark = op.allParsedLines.length;
  op.send(`CHECK ${nick} -b`);
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const lines = op.allParsedLines.slice(mark);
    const hit = lines.find(m => m.command === '290' && /Active time::\s*(\d+)s/.test(m.params[1] ?? ''));
    if (hit)
      return Number(/Active time::\s*(\d+)s/.exec(hit.params[1] ?? '')![1]);
    if (lines.some(m => m.command === '291'))   // end of CHECK
      break;
    await sleep(100);
  }
  return null;
}

describe('Bouncer session active time across servers', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) {
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a hold tells the other servers the active time it accrued', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    const { client: primary, nick } = await createBouncerClient(account, password,
      { nick: uniqueNick('acta') });
    track(primary);

    const op = track(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
    await op.capLs();
    op.capEnd();
    op.register(uniqueNick('actop'));
    await op.waitForNumeric('001');
    op.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await op.waitForNumeric('381', 5000);

    // Attached on the hub for a while, then dropped: the hub accrues it.
    await sleep(15_000);
    disconnectAbruptly(primary);
    await sleep(2500);

    const seen = await activeTime(op, nick);
    expect(seen, 'the leaf\'s CHECK -b shows an active time').not.toBeNull();
    expect(seen!, 'the leaf knows the ~15 s the hub accrued').toBeGreaterThanOrEqual(12);

    // Revive and clean up.
    const { client: back } = await createSaslBouncerClient(account, password, { nick: uniqueNick('actb') });
    track(back);
    await bouncerDisableHold(back);
    back.send('QUIT');
  }, 90_000);
});
