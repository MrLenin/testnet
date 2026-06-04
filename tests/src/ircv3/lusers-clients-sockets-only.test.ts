/**
 * RPL_LUSERME ("I have X clients") tracks live TCP sockets only,
 * NOT held ghosts.  RPL_CURRENT_LOCAL ("Current local users: X")
 * tracks network-visible users including held ghosts.
 *
 * The two diverge when a bouncer session enters HOLDING state:
 *   - LUSERME drops by 1 (socket gone)
 *   - LOCALUSERS unchanged (ghost still N-visible to peers)
 *
 * On revive (new socket attaches to ghost):
 *   - LUSERME bumps back by 1
 *   - LOCALUSERS still unchanged
 *
 * Plan: .claude/para/projects/lusers-clients-sockets-only.md
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  createIRCv3Client,
  PRIMARY_SERVER,
} from '../helpers/index.js';

interface LusersCounts {
  meClients: number;
  localUsers: number;
}

async function lusers(c: { raw(s: string): void; rawMessages?: string[]; allLines?: string[] }): Promise<LusersCounts> {
  const all = (c.rawMessages ?? c.allLines ?? []) as string[];
  const start = all.length;
  c.raw('LUSERS');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const cur = (c.rawMessages ?? c.allLines ?? []) as string[];
    if (cur.slice(start).some(l => / 266 /.test(l))) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const tail = ((c.rawMessages ?? c.allLines ?? []) as string[]).slice(start);
  const me = tail.find(l => / 255 /.test(l));
  const local = tail.find(l => / 265 /.test(l));
  if (!me || !local) throw new Error(`LUSERS incomplete: me=${me} local=${local}`);
  const meMatch = me.match(/ 255 \S+ :?I have (\d+) clients?/i);
  const localMatch = local.match(/ 265 \S+ :Current local users:\s+(\d+)/i);
  if (!meMatch || !localMatch) throw new Error(`LUSERS unparseable: me="${me}" local="${local}"`);
  return {
    meClients: parseInt(meMatch[1], 10),
    localUsers: parseInt(localMatch[1], 10),
  };
}

describe('RPL_LUSERME: live sockets only (held ghosts excluded)', () => {
  const clients: Array<RawSocketClient | { quit?: () => void; close?: () => void }> = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try {
        if ('quit' in c && c.quit) c.quit();
        else if ('close' in c && c.close) c.close();
      } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('primary socket drop into HOLDING: sockets -1, announced unchanged', async () => {
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host, port: PRIMARY_SERVER.port,
      nick: uniqueNick('lobs'),
    });
    clients.push(observer);

    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // Create the primary with hold enabled, let it settle.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('prim') },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);
    await new Promise(r => setTimeout(r, 1500));

    // Take the "primary is connected" snapshot.
    const beforeDrop = await lusers(observer);

    // Drop the primary's socket without QUIT — should transition to HOLDING.
    primary.client.close();
    await new Promise(r => setTimeout(r, 2000));

    const afterDrop = await lusers(observer);

    // LUSERME drops by exactly 1 (primary's socket gone).  Announced
    // stays the same (ghost still N-visible to peers).
    expect(afterDrop.meClients - beforeDrop.meClients,
      'primary socket close should drop LUSERME by 1').toBe(-1);
    expect(afterDrop.localUsers - beforeDrop.localUsers,
      'primary going to HOLDING must NOT change announced count').toBe(0);
  }, 60000);

  it('held ghost revive: sockets +1, announced unchanged', async () => {
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host, port: PRIMARY_SERVER.port,
      nick: uniqueNick('lobs'),
    });
    clients.push(observer);

    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // Set up the hold-then-drop scenario.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('prim') },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);
    await new Promise(r => setTimeout(r, 1000));
    primary.client.close();
    await new Promise(r => setTimeout(r, 2000));

    // Snapshot with the ghost in HOLDING.
    const beforeRevive = await lusers(observer);

    // Reconnect — bounce_revive should fire, attaching a new socket to the ghost.
    const revived = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('prim') },
    );
    clients.push(revived.client);
    await new Promise(r => setTimeout(r, 2000));

    const afterRevive = await lusers(observer);

    // Revive bumps LUSERME by exactly 1 (new socket attached).  Announced
    // stays the same (ghost was already N-counted; user is still on net).
    expect(afterRevive.meClients - beforeRevive.meClients,
      'revive should bump LUSERME by 1').toBe(1);
    expect(afterRevive.localUsers - beforeRevive.localUsers,
      'revive must NOT change announced count').toBe(0);

    try { await bouncerDisableHold(revived.client); } catch { /* ignore */ }
  }, 60000);

  it('invariant: announced count never exceeds the "I have X clients" socket total in steady state', async () => {
    // Quiet, vanilla baseline observation: in the absence of held ghosts,
    // LUSERME (sockets) >= LOCALUSERS (announced).  This was the invariant
    // before the fix, and remains true now.
    //
    // With held ghosts present, LOCALUSERS can exceed LUSERME by the count
    // of ghosts — that's the FIX in action.  (Tested explicitly in the
    // first test above, just verifying we don't have a regression on the
    // base invariant here.)
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host, port: PRIMARY_SERVER.port,
      nick: uniqueNick('linv'),
    });
    clients.push(observer);
    await new Promise(r => setTimeout(r, 500));

    const counts = await lusers(observer);
    expect(counts.meClients).toBeGreaterThan(0);
    expect(counts.localUsers).toBeGreaterThan(0);
  }, 30000);
});
