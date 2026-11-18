import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient, uniqueNick, getTestAccount, releaseTestAccount,
  createSaslBouncerClient, SECONDARY_SERVER,
} from '../helpers/index.js';
import { createTlsClient, tlsEnableHold, tlsDisableHold, type TlsClient } from '../helpers/tls-sasl-client.js';

/**
 * +Z and a plaintext bouncer device (evilnet/nefarious2 #159, #162).  The bed
 * runs CHMODE_Z_STRICT at its default, TRUE.  A plaintext device is a member
 * of its primary's channels as a hidden alias, so an op sees only TLS users.
 *
 * Red until #162 is merged and the bed's nefarious slots are rebuilt: run with
 * NEF_PR_162=1 then.  (An explicit gate, not a silent skipIf.)
 */
const GATED = process.env.NEF_PR_162 !== '1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('#162 CHMODE_Z_STRICT counts a plaintext bouncer alias', () => {
  const tlsClients: TlsClient[] = [];
  const held: TlsClient[] = [];
  const rawClients: RawSocketClient[] = [];
  const pool: string[] = [];

  afterEach(async () => {
    for (const c of held) { try { await tlsDisableHold(c); } catch { /* */ } }
    held.length = 0;
    for (const c of tlsClients) c.close();
    tlsClients.length = 0;
    for (const c of rawClients) { try { c.close(); } catch { /* */ } }
    rawClients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  /** A TLS op in a new channel, and a TLS primary of an account, joined. */
  async function bed() {
    const chan = `#zst${Math.random().toString(36).slice(2, 7)}`;
    const op = await createTlsClient(uniqueNick('zop'));
    tlsClients.push(op);
    op.send(`JOIN ${chan}`);
    await sleep(500);
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const primary = await createTlsClient(uniqueNick('zpr'), { account: acc.account, password: acc.password });
    tlsClients.push(primary);
    held.push(primary);
    await tlsEnableHold(primary);
    primary.send(`JOIN ${chan}`);
    await sleep(500);
    return { chan, op, primary, acc };
  }

  it.skipIf(GATED)('same server: a TLS op setting +Z is refused while a plaintext alias is present, allowed after it quits', async () => {
    const { chan, op, acc } = await bed();
    const { client: device } = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('zdv') });
    rawClients.push(device);
    await sleep(1000);

    let from = op.lines.length;
    op.send(`MODE ${chan} +Z`);
    const refusal = await op.waitFor(/ 974 /, from, 5000);
    expect(refusal).toContain('non-SSL bouncer connection');

    device.send('QUIT');
    device.close();
    rawClients.length = 0;
    await sleep(1500);

    from = op.lines.length;
    op.send(`MODE ${chan} +Z`);
    await op.waitFor(/ MODE \S+ \+Z/, from, 5000);
  }, 60_000);

  it.skipIf(GATED)('cross-server: an alias on the leaf refuses +Z here, through the mirror', async () => {
    const { chan, op, acc } = await bed();
    const { client: device } = await createSaslBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('zdl'), host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port,
    });
    rawClients.push(device);
    await sleep(2000);

    const from = op.lines.length;
    op.send(`MODE ${chan} +Z`);
    const refusal = await op.waitFor(/ 974 /, from, 5000);
    expect(refusal).toContain('non-SSL bouncer connection');
  }, 60_000);

  /* KNOWN GAP, evilnet/nefarious2 #165.  The device is correctly kept out of
   * the channel, but the can-send check reads the TLS rule session-wide, so
   * the TLS primary is kicked on its next line.  This pins today's behaviour:
   * #165 should flip it to "not kicked". */
  it.skipIf(GATED)('known gap: a plaintext device attaching after +Z gets its TLS primary kicked on its next line', async () => {
    const { chan, op, primary, acc } = await bed();
    const from = op.lines.length;
    op.send(`MODE ${chan} +Z`);
    await op.waitFor(/ MODE \S+ \+Z/, from, 5000);

    const { client: device } = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('zdk') });
    rawClients.push(device);
    await sleep(1000);

    const at = primary.lines.length;
    primary.send(`PRIVMSG ${chan} :hello`);
    const kick = await primary.waitFor(/ KICK /, at, 5000);
    expect(kick).toContain('SSL-only channel (insecure session)');
  }, 60_000);
});
