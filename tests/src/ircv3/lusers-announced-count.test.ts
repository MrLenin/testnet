/**
 * RPL_CURRENT_LOCAL / RPL_CURRENT_GLOBAL should advertise the
 * network-visible (N-announced) user count, not the raw socket
 * count.  Bouncer aliases come in via BX C (not N), so they
 * count toward sockets (RPL_LUSERME) but NOT toward the user
 * counts (RPL_CURRENT_LOCAL, RPL_CURRENT_GLOBAL).
 *
 * Plan: .claude/para/projects/rpl-localusers-announced-count.md
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

/** Parsed counts from a single LUSERS sequence. */
interface LusersCounts {
  /** RPL_LUSERME first arg — local sockets. */
  meClients: number;
  /** RPL_CURRENT_LOCAL — local announced users. */
  localUsers: number;
  /** RPL_CURRENT_LOCAL second arg — max. */
  localUsersMax: number;
  /** RPL_CURRENT_GLOBAL — global announced users. */
  globalUsers: number;
  /** RPL_CURRENT_GLOBAL second arg — max. */
  globalUsersMax: number;
}

async function lusers(client: { raw(s: string): void; rawMessages?: string[]; allLines?: string[] } & object): Promise<LusersCounts> {
  const startLen = ((client.rawMessages ?? client.allLines ?? []) as string[]).length;
  client.raw('LUSERS');

  // Wait until we see RPL_CURRENT_GLOBAL (266) in the post-issue tail
  // — that's the last line of the LUSERS reply.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const all = (client.rawMessages ?? client.allLines ?? []) as string[];
    const tail = all.slice(startLen);
    if (tail.some(l => / 266 /.test(l))) break;
    await new Promise(r => setTimeout(r, 50));
  }

  const all = (client.rawMessages ?? client.allLines ?? []) as string[];
  const tail = all.slice(startLen);

  const me = tail.find(l => / 255 /.test(l));
  const localLine = tail.find(l => / 265 /.test(l));
  const globalLine = tail.find(l => / 266 /.test(l));
  if (!me || !localLine || !globalLine) {
    throw new Error(
      `LUSERS reply incomplete: me=${me ?? 'MISSING'} | local=${localLine ?? 'MISSING'} | global=${globalLine ?? 'MISSING'}`,
    );
  }

  const meMatch = me.match(/ 255 \S+ :?I have (\d+) clients?/i);
  const localMatch = localLine.match(/ 265 \S+ :Current local users:\s+(\d+)\s+Max:\s+(\d+)/i);
  const globalMatch = globalLine.match(/ 266 \S+ :Current global users:\s+(\d+)\s+Max:\s+(\d+)/i);
  if (!meMatch || !localMatch || !globalMatch) {
    throw new Error(`LUSERS reply unparseable: me="${me}" local="${localLine}" global="${globalLine}"`);
  }
  return {
    meClients: parseInt(meMatch[1], 10),
    localUsers: parseInt(localMatch[1], 10),
    localUsersMax: parseInt(localMatch[2], 10),
    globalUsers: parseInt(globalMatch[1], 10),
    globalUsersMax: parseInt(globalMatch[2], 10),
  };
}

describe('RPL_CURRENT_LOCAL/GLOBAL: announced (N-token) count, not socket count', () => {
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
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('vanilla client: announced and sockets agree (no aliases)', async () => {
    const c = await createIRCv3Client({
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
      nick: uniqueNick('lvanilla'),
    });
    clients.push(c);

    const counts = await lusers(c);
    // We can't hardcode totals (test depends on what else is on the
    // network), but we CAN assert internal consistency: announced
    // counts should never exceed socket counts, and both should be
    // positive (we just connected).
    expect(counts.meClients).toBeGreaterThan(0);
    expect(counts.localUsers).toBeGreaterThan(0);
    expect(counts.globalUsers).toBeGreaterThan(0);
    expect(counts.localUsers).toBeLessThanOrEqual(counts.meClients);
    // Max fields should be at least the current value (saved when current exceeded).
    expect(counts.localUsersMax).toBeGreaterThanOrEqual(counts.localUsers);
    expect(counts.globalUsersMax).toBeGreaterThanOrEqual(counts.globalUsers);
  }, 30000);

  it('alias attach: sockets +1, announced unchanged (the fix in action)', async () => {
    // Observer (vanilla) takes a stable baseline.
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
      nick: uniqueNick('lobs'),
    });
    clients.push(observer);

    // Create the primary first and let it settle so any session-restore
    // / ghost-revive accounting completes before we take "before".
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('lprim') },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);
    await new Promise(r => setTimeout(r, 1000));

    // Snapshot the BEFORE-alias state.  Bouncer session-restore semantics
    // make the primary-connect deltas vary (ghost-spawn + revive stacks
    // counts when the account had a prior session), so anchor on the
    // post-primary state instead.
    const before = await lusers(observer);

    // Attach an alias on the same account.
    const alias = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('lali') },
    );
    clients.push(alias.client);
    await new Promise(r => setTimeout(r, 1500));

    const after = await lusers(observer);

    // Sockets went up by exactly 1 (the alias's socket).
    expect(after.meClients - before.meClients,
      'alias socket should show in RPL_LUSERME').toBe(1);

    // Announced UNCHANGED: aliases come in via BX C, not N — they're
    // not network-visible users.  This is the central property the
    // RPL_CURRENT_LOCAL fix delivers: the line no longer over-reports
    // by counting socket-state instead of N-state.
    expect(after.localUsers - before.localUsers,
      'alias must NOT bump RPL_CURRENT_LOCAL (it is BX C, not N)').toBe(0);
    expect(after.globalUsers - before.globalUsers,
      'alias must NOT bump RPL_CURRENT_GLOBAL').toBe(0);

    // Cleanup: disable hold so the session cleanly exits.
    try { await bouncerDisableHold(primary.client); } catch { /* ignore */ }
  }, 60000);

  it('alias detach: sockets -1, announced unchanged', async () => {
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
      nick: uniqueNick('lobs'),
    });
    clients.push(observer);

    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('lprim') },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);
    const alias = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('lali') },
    );
    clients.push(alias.client);
    await new Promise(r => setTimeout(r, 1500));

    // Snapshot with both connected.
    const before = await lusers(observer);

    // Detach the alias (clean QUIT through the socket so it goes through
    // the IsBouncerAlias exit branch in exit_one_client).
    alias.client.send('QUIT :test detach');
    await new Promise(r => setTimeout(r, 1500));

    const after = await lusers(observer);

    expect(after.meClients - before.meClients,
      'alias socket leaving should drop RPL_LUSERME by 1').toBe(-1);
    expect(after.localUsers - before.localUsers,
      'alias leaving must NOT change RPL_CURRENT_LOCAL').toBe(0);
    expect(after.globalUsers - before.globalUsers,
      'alias leaving must NOT change RPL_CURRENT_GLOBAL').toBe(0);

    try { await bouncerDisableHold(primary.client); } catch { /* ignore */ }
  }, 60000);

  it('announced never exceeds local sockets (invariant check)', async () => {
    // Sanity invariant: at any quiescent moment, the count of N-announced
    // users on this server can't exceed the count of clients (sockets +
    // ghosts) we're tracking.  If this ever fires, the announced
    // accounting has a leak (announced bumps without matching local_clients
    // bumps).
    const observer = await createIRCv3Client({
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
      nick: uniqueNick('linv'),
    });
    clients.push(observer);
    await new Promise(r => setTimeout(r, 500));
    const counts = await lusers(observer);
    // Note: held ghosts ARE counted in local_clients (per the existing
    // ++UserStats.local_clients in bounce_create_ghost), so the sum of
    // primaries + ghosts shows up in both meClients and localUsers.
    // The inequality therefore holds.
    expect(counts.localUsers,
      `RPL_CURRENT_LOCAL (${counts.localUsers}) should not exceed RPL_LUSERME (${counts.meClients})`,
    ).toBeLessThanOrEqual(counts.meClients);
  }, 30000);
});
