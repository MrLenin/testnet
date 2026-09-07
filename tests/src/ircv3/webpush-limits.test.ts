import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  uniqueId,
  uniqueNick,
  X3Client,
  PRIMARY_SERVER,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * draft/webpush registration cap (FEAT_WEBPUSH_MAX_REGISTRATIONS, default
 * 10).  Without it one account could register any number of endpoints and
 * every message would fan out to all of them.  Spec failure:
 *   FAIL WEBPUSH MAX_REGISTRATIONS REGISTER <endpoint> :<message>
 * A re-REGISTER of an endpoint already held re-arms it and never counts.
 */

const MAX = 10;

function keys(): string {
  // A P-256 uncompressed point (0x04 + 64 bytes) and a 16-byte auth
  // secret, base64url without padding: what a browser hands over.
  const p256dh = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return `p256dh=${p256dh};auth=${auth}`;
}

async function register(c: X3Client, endpoint: string) {
  c.clearRawBuffer();
  c.send(`WEBPUSH REGISTER ${endpoint} ${keys()}`);
  return c.waitForParsedLine(
    m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL',
    5000);
}

describe('draft/webpush registration cap', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];
  const registered: { c: X3Client; endpoints: string[] }[] = [];

  afterEach(async () => {
    for (const r of registered) {
      for (const e of r.endpoints) {
        try { r.c.send(`WEBPUSH UNREGISTER ${e}`); } catch { /* */ }
      }
    }
    await new Promise(r => setTimeout(r, 500));
    registered.length = 0;
    for (const c of clients) {
      try { await bouncerDisableHold(c); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it(`accepts ${MAX} endpoints, refuses the next with MAX_REGISTRATIONS, and still re-arms a held one`, async () => {
    const c = new X3Client();
    clients.push(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq(['draft/webpush', 'sasl']);
    c.capEnd();
    c.register(uniqueNick('wpcap'));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    c.clearRawBuffer();
    const { account, fromPool } = await setupTestAccount(c);
    if (fromPool) poolAccounts.push(account);

    // Start from a clean slate: the pool account may hold endpoints from
    // earlier runs.  There is no LIST, so unregister what this run will
    // use and rely on the sweep for anything older.
    const stem = uniqueId();
    const endpoints: string[] = [];
    for (let i = 0; i < MAX + 1; i++)
      endpoints.push(`https://updates.push.services.mozilla.com/wpush/v2/${stem}-${i}`);
    registered.push({ c, endpoints });

    let accepted = 0;
    let refused: string | null = null;
    for (const e of endpoints) {
      const reply = await register(c, e);
      if (reply.command === 'WEBPUSH') accepted++;
      else { refused = reply.raw; break; }
    }
    // Earlier runs may have left endpoints on the account, so the exact
    // acceptance count can be lower than MAX; what must hold is that the
    // refusal exists, carries the spec code, and never passes MAX.
    expect(accepted, 'more registrations accepted than the cap allows').toBeLessThanOrEqual(MAX);
    expect(refused, `no MAX_REGISTRATIONS refusal after ${accepted} registrations`).not.toBeNull();
    expect(refused).toMatch(/^:?\S* ?FAIL WEBPUSH MAX_REGISTRATIONS REGISTER https:\/\//);

    // A held endpoint re-registers at the cap (re-arm), never refused.
    const again = await register(c, endpoints[0]);
    expect(again.command, `re-REGISTER of a held endpoint answered: ${again.raw}`).toBe('WEBPUSH');
  }, 60000);
});
