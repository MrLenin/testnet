/**
 * evilnet/CHATHISTORYRETENTION ISUPPORT token (fork extension, 2026-09-08).
 *
 * The server does not retain history older than `now - value` seconds;
 * a client should not page past that horizon.  It is a hint, not a
 * permission: requests past it are still answered honestly (empty page
 * with chathistory-end, or FAIL MESSAGE_ERROR for an anchor msgid the
 * store cannot place).  Field report: goguma kept paging a PM buffer
 * back to May with a pre-repack msgid, four months past the 7-day
 * retention.  Vendor-prefixed like IRCv3's draft/ICON.
 *
 * Advertised only by storage servers, as days*86400; a rehash / SET of
 * CHATHISTORY_RETENTION re-announces it through draft/extended-isupport.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, IRC_OPER, uniqueNick } from '../helpers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tokens(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    if (!/ 005 /.test(l)) continue;
    const body = l.replace(/^(@\S+ )?:\S+ 005 \S+ /, '').replace(/ :are supported.*$/, '');
    for (const t of body.split(' ')) {
      const [k, v] = t.split('=');
      if (k) out[k] = v ?? '';
    }
  }
  return out;
}

describe('evilnet/CHATHISTORYRETENTION ISUPPORT', () => {
  const clients: RawSocketClient[] = [];
  afterEach(() => { for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0; });

  it('is advertised in seconds next to CHATHISTORY, and re-announced when retention changes', async () => {
    const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(c);
    await c.capLs(); await c.capReq(['draft/extended-isupport']); c.capEnd();
    c.register(uniqueNick('ret'));
    await c.waitForNumeric('001');
    await sleep(800);
    const t = tokens(c.allLines);
    expect(t.CHATHISTORY, 'spec token present').toMatch(/^\d+$/);
    expect(t['evilnet/CHATHISTORYRETENTION'], 'retention token present').toMatch(/^\d+$/);
    const days = Number(t['evilnet/CHATHISTORYRETENTION']) / 86400;
    expect(Number.isInteger(days) && days > 0, 'whole days in seconds').toBe(true);

    // Change retention through an oper SET; the extended-isupport client
    // gets a fresh 005 carrying the new value.  Restore afterwards.
    const oper = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(oper);
    await oper.capLs(); oper.capEnd(); oper.register(uniqueNick('rop'));
    await oper.waitForNumeric('001');
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    const before = c.allLines.length;
    const newDays = days === 3 ? 4 : 3;
    try {
      oper.send(`SET CHATHISTORY_RETENTION ${newDays}`);
      await c.waitForLine(new RegExp(` 005 .*evilnet/CHATHISTORYRETENTION=${newDays * 86400}\\b`), 8000);
      const t2 = tokens(c.allLines.slice(before));
      expect(t2['evilnet/CHATHISTORYRETENTION']).toBe(String(newDays * 86400));
    } finally {
      oper.send(`SET CHATHISTORY_RETENTION ${days}`);
      await sleep(500);
    }
  });
});
