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
 * Since 2026-09-20 the value is the WIDEST retention over the stores the
 * server can reach: itself when it stores, plus every linked server
 * advertising storage (CH A S / R).  It is re-announced through
 * draft/extended-isupport whenever a store links, leaves (no grace: it
 * drops at once, the store may never be back) or changes its retention;
 * so it can rise again, and a client must not treat the horizon as final.
 * 0 means a reachable store keeps history for good; absent means no store
 * is reachable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, SECONDARY_SERVER, IRC_OPER, uniqueNick, isSecondaryServerAvailable } from '../helpers/index.js';

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

/** Wait for a 005 received after `start` to carry the token at `expected`. */
async function waitForToken(c: RawSocketClient, start: number, expected: number, timeout: number): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (tokens(c.allLines.slice(start))['evilnet/CHATHISTORYRETENTION'] === String(expected)) return;
    await sleep(200);
  }
  throw new Error(`no new 005 with evilnet/CHATHISTORYRETENTION=${expected} within ${timeout} ms:\n${c.allLines.slice(start).filter(l => / 005 /.test(l)).join('\n')}`);
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
    // Wider than any linked store, or the widest value would not move.
    const newDays = days + 5;
    try {
      oper.send(`SET CHATHISTORY_RETENTION ${newDays}`);
      await waitForToken(c, before, newDays * 86400, 8000);
    } finally {
      oper.send(`SET CHATHISTORY_RETENTION ${days}`);
      await sleep(500);
    }
  });
  async function operOn(server: { host: string; port: number }, tag: string): Promise<RawSocketClient> {
    const oper = await createRawSocketClient(server.host, server.port);
    clients.push(oper);
    await oper.capLs(); oper.capEnd(); oper.register(uniqueNick(tag));
    await oper.waitForNumeric('001');
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    return oper;
  }

  async function hubWatcher(): Promise<RawSocketClient> {
    const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(c);
    await c.capLs(); await c.capReq(['draft/extended-isupport']); c.capEnd();
    c.register(uniqueNick('rw'));
    await c.waitForNumeric('001');
    await sleep(800);
    return c;
  }

  it('is the widest over the hub and its linked leaf, and follows the leaf\'s retention', async () => {
    if (!(await isSecondaryServerAvailable())) return;
    const c = await hubWatcher();
    const hubDays = Number(tokens(c.allLines)['evilnet/CHATHISTORYRETENTION']) / 86400;
    expect(hubDays).toBeGreaterThan(0);
    const leafOper = await operOn(SECONDARY_SERVER, 'lop');
    const wider = hubDays + 23;
    try {
      let before = c.allLines.length;
      leafOper.send(`SET CHATHISTORY_RETENTION ${wider}`);
      await waitForToken(c, before, wider * 86400, 8000);
      // Back down: the leaf narrows, the hub's value drops to the widest that is left.
      before = c.allLines.length;
      leafOper.send(`SET CHATHISTORY_RETENTION ${hubDays}`);
      await waitForToken(c, before, hubDays * 86400, 8000);
    } finally {
      leafOper.send(`SET CHATHISTORY_RETENTION ${hubDays}`);
      await sleep(400);
    }
  }, 40000);

  it('drops the moment the wider store leaves, and rises when it is back', async () => {
    if (!(await isSecondaryServerAvailable())) return;
    const c = await hubWatcher();
    const hubDays = Number(tokens(c.allLines)['evilnet/CHATHISTORYRETENTION']) / 86400;
    const leafOper = await operOn(SECONDARY_SERVER, 'lsq');
    const hubOper = await operOn(PRIMARY_SERVER, 'hsq');
    const wider = hubDays + 31;
    try {
      let before = c.allLines.length;
      leafOper.send(`SET CHATHISTORY_RETENTION ${wider}`);
      await waitForToken(c, before, wider * 86400, 8000);

      before = c.allLines.length;
      hubOper.send('SQUIT leaf.fractalrealities.net :retention test');
      await waitForToken(c, before, hubDays * 86400, 10000);   // no grace: the hub alone

      before = c.allLines.length;
      hubOper.send('CONNECT leaf.fractalrealities.net');
      await waitForToken(c, before, wider * 86400, 30000);     // the store is back: it rises again
    } finally {
      leafOper.send(`SET CHATHISTORY_RETENTION ${hubDays}`);
      await sleep(400);
    }
  }, 90000);
});
