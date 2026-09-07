import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
} from '../helpers/index.js';

/**
 * #585 draft/ACCOUNTREQUIRED, per-CLASS: our account gating is
 * class-conditional (require_sasl on the class the port selects), so
 * the ISUPPORT token is emitted per-connection — only clients whose
 * resolved class carries the gate see it. Port 6675 is the gated test
 * class; 6667 is ungated.
 *
 * Unauthenticated registration on the gated port must be refused with
 * FAIL * ACCOUNT_REQUIRED before the disconnect (shipped d961068).
 */

const GATED_PORT = 6675;

// RawSocketClient keeps its received lines private; reach in for raw scans.
const rawOf = (c: unknown): string[] =>
  (c as { lines: { raw: string }[] }).lines.map(l => l.raw);

let cleanup: Array<() => void> = [];
let poolRelease: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const f of cleanup) f();
  cleanup = [];
  if (poolRelease) { await poolRelease(); poolRelease = null; }
});

describe('per-class draft/ACCOUNTREQUIRED', () => {
  it('unauthenticated registration on the gated port fails with ACCOUNT_REQUIRED', async () => {
    const c = await createRawSocketClient(PRIMARY_SERVER.host, GATED_PORT);
    cleanup.push(() => c.close());
    await c.capLs();
    c.capEnd();
    c.register(uniqueNick('arfail'));
    const line = await c.waitForLine(/FAIL \* ACCOUNT_REQUIRED/, 8000);
    expect(line).toMatch(/FAIL \* ACCOUNT_REQUIRED/);
  });

  it('authenticated client on the gated port sees the ISUPPORT token; ungated port does not', async () => {
    // Mint an account on the ungated port first
    const minter = new X3Client();
    cleanup.push(() => minter.close());
    await minter.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await minter.capLs();
    minter.capEnd();
    minter.register(uniqueNick('armint'));
    await minter.waitForNumeric('001');

    // Ungated 005 burst must not carry the token
    const ungated005 = rawOf(minter).filter(l => /\s005\s/.test(l));
    expect(ungated005.length).toBeGreaterThan(0);
    expect(ungated005.join('\n')).not.toMatch(/draft\/ACCOUNTREQUIRED/);

    await new Promise(r => setTimeout(r, 300));
    minter.clearRawBuffer();
    const { account, password, fromPool } = await setupTestAccount(minter);
    poolRelease = fromPool ? () => releaseTestAccount(account) : null;

    // SASL pre-registration on the gated port
    const c = await createRawSocketClient(PRIMARY_SERVER.host, GATED_PORT);
    cleanup.push(() => c.close());
    await c.capLs();
    await c.capReq(['sasl']);
    c.send('AUTHENTICATE PLAIN');
    await c.waitForLine(/^AUTHENTICATE \+/, 8000);
    const payload = Buffer.from(`${account}\0${account}\0${password}`).toString('base64');
    c.send(`AUTHENTICATE ${payload}`);
    const saslResult = await c.waitForLine(/ (900|903|904|905|906) /, 10000);
    expect(saslResult, 'pre-registration SASL on the gated port failed').toMatch(/ 90[03] /);
    c.capEnd();
    c.register(uniqueNick('argate'));
    await c.waitForNumeric('001');
    await c.waitForNumeric('376', 8000).catch(() => { /* motd end best-effort */ });

    const gated005 = rawOf(c).filter(l => /\s005\s/.test(l));
    expect(gated005.length).toBeGreaterThan(0);
    expect(gated005.join('\n'), 'gated class must advertise draft/ACCOUNTREQUIRED')
      .toMatch(/draft\/ACCOUNTREQUIRED/);
  }, 30000);
});
