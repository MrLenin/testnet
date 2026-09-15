import { describe, it, expect, afterEach } from 'vitest';
import {
  X3Client,
  RawSocketClient,
  OPSERV_NICK,
  createOperClient,
  createRawSocketClient,
  uniqueNick,
  uniqueChannel,
} from '../helpers/index.js';

/**
 * The fork's channel modes +H (public history) and +P (no storage) and user
 * modes +M +Y +y +b must be *known* to the legacy halves of a mixed network,
 * even though only the fork acts on them:
 *
 *  - X3's mod_chanmode_parse() rejects a user-typed mode string on an
 *    unknown letter (a change from a server skips it), so OpServ/ChanServ
 *    MODE and the mode locks answered "invalid set of channel modes" for
 *    +H/+P and X3 could not re-emit them (evilnet/x3 #61).
 *  - upstream nefarious2 drops an unknown letter when relaying, so a fork
 *    server behind a legacy hub never sees the change, and a user on the
 *    legacy server cannot set one (evilnet/nefarious2 #114).
 *
 * The legacy slot is the bed's unmodified-upstream container (host port
 * 6671); its cases skip when it is not up.
 */

const LEGACY_HOST = process.env.IRC_HOST ?? 'nefarious';
const LEGACY_PORT = parseInt(process.env.LEGACY_PORT ?? '6671');

async function legacyClient(): Promise<RawSocketClient | null> {
  try {
    const c = await createRawSocketClient(LEGACY_HOST, LEGACY_PORT);
    await c.capLs(); c.capEnd(); c.register(uniqueNick('lgcy'));
    await c.waitForNumeric('001', 15000);
    return c;
  } catch {
    return null;
  }
}

/* Red until evilnet/x3 #61 and evilnet/nefarious2 #114 are merged and the
 * bed's x3 and nefarious-upstream slots are rebuilt: run with
 * LEGACY_MODE_LETTERS=1 then.  (An explicit gate, not a silent skipIf.) */
const GATED = process.env.LEGACY_MODE_LETTERS !== '1';

describe('legacy halves know the fork mode letters', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  afterEach(() => {
    for (const c of clients) { try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
  });

  it.skipIf(GATED)('OpServ MODE accepts +H (a user-typed mode string, where X3 refused unknown letters)', async () => {
    const o = await createOperClient(); clients.push(o);
    const ch = uniqueChannel('mdh');
    o.send(`JOIN ${ch}`); await o.waitForJoin(ch);
    o.clearRawBuffer();
    const lines = await o.serviceCmd(OPSERV_NICK, `MODE ${ch} +H`, 10000);
    expect(lines.join('\n')).not.toMatch(/invalid set of channel modes/);
    await new Promise(r => setTimeout(r, 1000));
    o.clearRawBuffer();
    o.send(`MODE ${ch}`);
    const m = await o.waitForNumeric('324', 10000);
    expect(m.params[2], m.raw).toMatch(/H/);
  }, 30000);

  it.skipIf(GATED)('a legacy server keeps +H set from the fork and lets its own user set +P', async () => {
    const l = await legacyClient();
    if (!l) return;
    clients.push(l);
    const o = await createOperClient(); clients.push(o);
    const ch = uniqueChannel('mdl');
    o.send(`JOIN ${ch}`); await o.waitForJoin(ch);
    o.send(`MODE ${ch} +ntH`);
    l.send(`JOIN ${ch}`);
    await l.waitForParsedLine(m => m.command === 'JOIN' && m.params[0]?.toLowerCase() === ch.toLowerCase(), 10000);
    await new Promise(r => setTimeout(r, 1000));
    l.clearRawBuffer();
    l.send(`MODE ${ch}`);
    const m1 = await l.waitForNumeric('324', 10000);
    expect(m1.params[2], m1.raw).toMatch(/H/);

    // A legacy-side op sets +P; the fork must see it.
    o.send(`MODE ${ch} +o ${l.nick}`);
    await new Promise(r => setTimeout(r, 1000));
    l.send(`MODE ${ch} +P`);
    await new Promise(r => setTimeout(r, 1500));
    o.clearRawBuffer();
    o.send(`MODE ${ch}`);
    const m2 = await o.waitForNumeric('324', 10000);
    expect(m2.params[2], m2.raw).toMatch(/P/);
  }, 45000);
});
