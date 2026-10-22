import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  RawSocketClient,
  createRawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import type { IRCMessage } from '../helpers/index.js';
import {
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  disconnectAbruptly,
} from '../helpers/bouncer.js';

/**
 * A bouncer session's server notice mask (snomask, 008 RPL_SNOMASK).
 *
 * Field reports 2026-10-21: an alias asking for the mask (Seance's oper
 * module sends `MODE <me> +s +0`) had the 008 delivered to the primary's
 * socket instead; and a revived oper came back with +s but a zero mask
 * (`008 <me> 0 :: Server notice mask (0x0)`), because close_connection()
 * zeroes the mask when the held socket goes and nothing put it back.  The
 * rule (user, 2026-10-21): wherever the bouncer gives a manually opered
 * user their +o back, their own mask comes back with it -- not the
 * O:line default.
 *
 * MASK is the oper default (SNO_OPERDEFAULT 0x160d) plus SNO_CONNEXIT, so a
 * fallback to the default is told apart from a restore, and `MODE <me>`
 * answers with an 008 (it only does for a non-default mask).
 */

const MASK = 0x160d | 0x4000;
/** Another non-default mask: MASK plus SNO_IPMISMATCH. */
const MASK2 = MASK | 0x800;
/** And a third: MASK plus SNO_HACK3. */
const MASK3 = MASK | 0x10;
/** SNO_OPER: the bits only an oper may hold (connexit, oldrealop, auth). */
const SNO_OPER = 0x4000 | 0x2000 | 0x40000;

const RUN_RESTART = process.env.RUN_RESTART_TESTS === '1';

/** The 008s among @a lines, as the decimal mask each carries. */
function masks(lines: IRCMessage[]): number[] {
  return lines.filter(m => m.command === '008').map(m => Number(m.params[1]));
}

/** Lines @a c received after index @a mark. */
function since(c: RawSocketClient, mark: number): IRCMessage[] {
  return c.allParsedLines.slice(mark);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Lines @a c received after @a mark, once @a done says they are enough
 * or @a ms has passed. */
async function until(c: RawSocketClient, mark: number,
  done: (lines: IRCMessage[]) => boolean, ms: number): Promise<IRCMessage[]> {
  const end = Date.now() + ms;
  while (Date.now() < end && !done(since(c, mark)))
    await sleep(100);
  return since(c, mark);
}

/** A MODE line for @a nick that turns @a letter on / off. */
function modeChange(m: IRCMessage, nick: string, letter: string, on: boolean): boolean {
  if (m.command !== 'MODE' || m.params[0] !== nick)
    return false;
  let adding = true;
  for (const ch of m.params.slice(1).join('')) {
    if (ch === '+') adding = true;
    else if (ch === '-') adding = false;
    else if (ch === letter && adding === on) return true;
  }
  return false;
}
const isModeOn = (m: IRCMessage, nick: string, l: string) => modeChange(m, nick, l, true);
const isModeOff = (m: IRCMessage, nick: string, l: string) => modeChange(m, nick, l, false);

async function operUp(c: RawSocketClient, nick: string): Promise<void> {
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForNumeric('381', 5000);
  c.send(`MODE ${nick} +s ${MASK}`);
  const reply = await c.waitForParsedLine(m => m.command === '008', 5000);
  expect(Number(reply.params[1]), 'setup: the custom mask took').toBe(MASK);
}

/** Ask the way Seance's oper module does and return what came back. */
async function askMask(c: RawSocketClient, query: string, settle = 1500): Promise<IRCMessage[]> {
  const mark = c.allParsedLines.length;
  c.send(query);
  await sleep(settle);
  return since(c, mark);
}

async function waitForNefariousReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execSync("docker inspect -f '{{.State.Health.Status}}' nefarious",
        { encoding: 'utf8' }).trim();
      if (status === 'healthy') {
        let probe: RawSocketClient | null = null;
        try {
          probe = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
          await Promise.race([
            probe.capLs(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cap ls timeout')), 3000)),
          ]);
          probe.capEnd();
          probe.send('QUIT');
          probe.close();
          return;
        } catch {
          if (probe) probe.close();
        }
      }
    } catch { /* mid-restart */ }
    await sleep(500);
  }
  throw new Error(`nefarious did not become ready within ${timeoutMs}ms`);
}

describe('Bouncer session server notice mask', () => {
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

  /** Drop oper and hold on a live connection so the pool account carries
   * neither a grant nor a held session into the next test. */
  async function cleanup(c: RawSocketClient, nick: string): Promise<void> {
    c.send(`MODE ${nick} -o`);
    await sleep(300);
    await bouncerDisableHold(c);
    c.send('QUIT');
  }

  it('an alias asking for the mask gets the 008 itself, not the primary', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    const { client: primary, nick } = await createBouncerClient(account, password,
      { nick: uniqueNick('snoa') });
    track(primary);
    await operUp(primary, nick);

    const { client: alias } = await createSaslBouncerClient(account, password,
      { nick: uniqueNick('snob') });
    track(alias);
    await sleep(1000);

    const primaryMark = primary.allParsedLines.length;
    const got = await askMask(alias, `MODE ${nick} +s +0`);
    expect(masks(got), 'the alias asked, so the alias gets the 008').toEqual([MASK]);
    expect(masks(since(primary, primaryMark)),
      'the primary asked nothing and must not get the alias\'s 008').toEqual([]);

    alias.send('QUIT');
    await sleep(300);
    await cleanup(primary, nick);
  }, 60_000);

  it('a revived oper keeps its mask: MODE <me> reports it, +s +0 leaves +s on', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    const { client: first, nick } = await createBouncerClient(account, password,
      { nick: uniqueNick('snor') });
    track(first);
    await operUp(first, nick);

    disconnectAbruptly(first);
    await sleep(1500);

    const { client: revived, nick: rnick } = await createSaslBouncerClient(account, password,
      { nick: uniqueNick('snor2') });
    track(revived);
    expect(rnick, 'setup: the reconnect revived the held session').toBe(nick);

    const query = await askMask(revived, `MODE ${nick}`);
    expect(masks(query), 'MODE <me> on the revived session reports the oper\'s own mask')
      .toEqual([MASK]);

    const read = await askMask(revived, `MODE ${nick} +s +0`);
    expect(masks(read), 'MODE <me> +s +0 answers with the mask').toEqual([MASK]);
    expect(read.some(m => m.command === 'MODE' && /-[a-zA-Z]*s/.test(m.params[1] ?? '')),
      'MODE <me> +s +0 must not turn +s off').toBe(false);

    await cleanup(revived, nick);
  }, 60_000);

  it('a held oper reconnecting to another server gets its mask there', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    const { client: first, nick } = await createBouncerClient(account, password,
      { nick: uniqueNick('snox') });
    track(first);
    await operUp(first, nick);

    disconnectAbruptly(first);
    await sleep(1500);

    const { client: moved, nick: mnick } = await createSaslBouncerClient(account, password, {
      nick: uniqueNick('snox2'), host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port,
    });
    track(moved);
    expect(mnick, 'setup: the session followed to the second server').toBe(nick);
    await sleep(1500);

    const query = await askMask(moved, `MODE ${nick}`);
    expect(masks(query), 'MODE <me> on the moved session reports the oper\'s own mask')
      .toEqual([MASK]);

    await cleanup(moved, nick);
  }, 60_000);

  describe('an alias on another server than its live opered primary', () => {
    /** Primary on the hub, opered with MASK; alias of it on the leaf. */
    async function pair(tag: string) {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);
      const { client: primary, nick } = await createBouncerClient(account, password,
        { nick: uniqueNick(tag) });
      track(primary);
      await operUp(primary, nick);
      const { client: alias, nick: anick } = await createSaslBouncerClient(account, password, {
        nick: uniqueNick(tag + 'l'), host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port,
      });
      track(alias);
      expect(anick, 'setup: the leaf connection joined the session').toBe(nick);
      return { primary, alias, nick };
    }

    async function done(primary: RawSocketClient, alias: RawSocketClient, nick: string) {
      alias.send('QUIT');
      await sleep(300);
      await cleanup(primary, nick);
    }

    it('is told +s and its mask, and MODE <me> there reports it', async () => {
      const { primary, alias, nick } = await pair('snol');
      const told = await until(alias, 0,
        lines => masks(lines).includes(MASK) && lines.some(m => isModeOn(m, nick, 's')), 5000);
      expect(told.some(m => isModeOn(m, nick, 's')), 'the alias is told it has +s').toBe(true);
      expect(masks(told), 'the alias is told its mask').toContain(MASK);
      expect(masks(await askMask(alias, `MODE ${nick}`)), 'MODE <me> on the leaf').toEqual([MASK]);
      await done(primary, alias, nick);
    }, 60_000);

    it('a mask set on the leaf reaches the primary\'s server', async () => {
      const { primary, alias, nick } = await pair('snoc');
      await sleep(2000);
      const pmark = primary.allParsedLines.length;
      const reply = await askMask(alias, `MODE ${nick} +s ${MASK2}`);
      expect(masks(reply), 'the alias that set it gets the 008').toEqual([MASK2]);
      const told = await until(primary, pmark, lines => masks(lines).includes(MASK2), 5000);
      expect(masks(told), 'the hub primary is told the new mask').toContain(MASK2);
      expect(masks(await askMask(primary, `MODE ${nick}`)), 'MODE <me> on the hub').toEqual([MASK2]);
      await done(primary, alias, nick);
    }, 60_000);

    it('an unrelated mode change of the primary leaves the alias its mask', async () => {
      const { primary, alias, nick } = await pair('snou');
      await sleep(2000);
      primary.send(`MODE ${nick} -w`);
      await sleep(500);
      primary.send(`MODE ${nick} +w`);
      await sleep(1500);
      expect(masks(await askMask(alias, `MODE ${nick}`)), 'MODE <me> on the leaf').toEqual([MASK]);
      await done(primary, alias, nick);
    }, 60_000);

    it('the primary turning +s off reaches the alias', async () => {
      const { primary, alias, nick } = await pair('snof');
      await sleep(2000);
      const amark = alias.allParsedLines.length;
      primary.send(`MODE ${nick} -s`);
      const told = await until(alias, amark, lines => lines.some(m => isModeOff(m, nick, 's')), 5000);
      expect(told.some(m => isModeOff(m, nick, 's')), 'the alias is told -s').toBe(true);
      const query = await askMask(alias, `MODE ${nick}`);
      const umodes = query.find(m => m.command === '221')?.params[1] ?? '';
      expect(umodes.includes('s'), `MODE <me> on the leaf shows no +s (${umodes})`).toBe(false);
      expect(masks(query)).toEqual([]);
      await done(primary, alias, nick);
    }, 60_000);

    it('the primary\'s -o leaves the alias no oper-only notice bits', async () => {
      const { primary, alias, nick } = await pair('snoo');
      await sleep(2000);
      primary.send(`MODE ${nick} -o`);
      await sleep(2500);
      const hub = masks(await askMask(primary, `MODE ${nick}`));
      const leaf = masks(await askMask(alias, `MODE ${nick}`));
      expect(leaf, 'the leaf reports what the hub reports').toEqual(hub);
      expect(leaf.every(m => (m & SNO_OPER) === 0),
        `no SNO_OPER bits left on the leaf (${leaf})`).toBe(true);
      alias.send('QUIT');
      await sleep(300);
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    }, 60_000);

    it('the alias\'s own MODE -s echoes -s after +s came by BX K', async () => {
      const { primary, alias, nick } = await pair('snoe');
      await until(alias, 0, lines => lines.some(m => isModeOn(m, nick, 's')), 5000);
      const pmark = primary.allParsedLines.length;
      const got = await askMask(alias, `MODE ${nick} -s`);
      expect(got.some(m => isModeOff(m, nick, 's')), 'the alias sees its -s echoed').toBe(true);
      const told = await until(primary, pmark, lines => lines.some(m => isModeOff(m, nick, 's')), 5000);
      expect(told.some(m => isModeOff(m, nick, 's')), 'the hub primary is told -s').toBe(true);
      await done(primary, alias, nick);
    }, 60_000);

    it('masks set at once on both servers end up the same on both', async () => {
      const { primary, alias, nick } = await pair('snox');
      await sleep(2000);
      primary.send(`MODE ${nick} +s ${MASK2}`);
      alias.send(`MODE ${nick} +s ${MASK3}`);
      await sleep(3000);
      const hub = masks(await askMask(primary, `MODE ${nick}`));
      const leaf = masks(await askMask(alias, `MODE ${nick}`));
      expect(hub.length, 'the hub reports a mask').toBe(1);
      expect(leaf, 'the leaf converged on the hub\'s mask').toEqual(hub);
      expect([MASK2, MASK3], 'one of the two that were set').toContain(hub[0]);
      await done(primary, alias, nick);
    }, 60_000);

    it('the alias receives server notices: an oper KILL', async () => {
      const { primary, alias, nick } = await pair('snok');
      await sleep(2000);
      // On the leaf: a KILL travels between servers only when the victim
      // is not on the killer's server (m_kill.c do_kill), and each server
      // the KILL reaches tells its own opers.
      const victim = track(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      const vnick = uniqueNick('snov');
      await victim.capLs();
      victim.capEnd();
      victim.register(vnick);
      await victim.waitForNumeric('001');
      await sleep(500);
      const amark = alias.allParsedLines.length;
      primary.send(`KILL ${vnick} :snomask test`);
      const got = await until(alias, amark,
        lines => lines.some(m => m.command === 'NOTICE' && /KILL/i.test(m.params[1] ?? '')
          && (m.params[1] ?? '').includes(vnick)), 5000);
      expect(got.some(m => m.command === 'NOTICE' && /KILL/i.test(m.params[1] ?? '')
        && (m.params[1] ?? '').includes(vnick)),
        'the leaf alias gets the KILL server notice (SNO_OPERKILL is in its mask)').toBe(true);

      // Control: the primary drops SNO_OPERKILL; once that reached the
      // leaf, the next KILL is not shown there -- delivery follows the
      // mask the alias was sent, nothing else.
      const noKill = MASK & ~0x4;
      const amark2 = alias.allParsedLines.length;
      primary.send(`MODE ${nick} +s ${noKill}`);
      const synced = await until(alias, amark2, lines => masks(lines).includes(noKill), 5000);
      expect(masks(synced), 'the alias is told the mask without SNO_OPERKILL').toContain(noKill);
      const victim2 = track(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      const vnick2 = uniqueNick('snov');
      await victim2.capLs();
      victim2.capEnd();
      victim2.register(vnick2);
      await victim2.waitForNumeric('001');
      await sleep(500);
      const amark3 = alias.allParsedLines.length;
      primary.send(`KILL ${vnick2} :snomask test`);
      await sleep(2500);
      expect(since(alias, amark3).some(m => m.command === 'NOTICE'
        && (m.params[1] ?? '').includes(vnick2)),
        'without SNO_OPERKILL the leaf alias gets no KILL notice').toBe(false);
      await done(primary, alias, nick);
    }, 60_000);
  });

  (RUN_RESTART ? it : it.skip)(
    'after an ircd restart the oper grant brings back the oper\'s own mask, not the default',
    async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: first, nick } = await createBouncerClient(account, password,
        { nick: uniqueNick('snoz') });
      track(first);
      await operUp(first, nick);
      // Let the dirty-persist timer write the record.
      await sleep(3000);

      disconnectAbruptly(first);
      await sleep(1500);

      execSync('docker restart nefarious', { encoding: 'utf8' });
      await waitForNefariousReady();
      // The bouncer holds 001 back until burst convergence settles.
      await sleep(35_000);

      const { client: revived, nick: rnick } = await createSaslBouncerClient(account, password,
        { nick: uniqueNick('snoz2') });
      track(revived);
      expect(rnick, 'setup: the reconnect revived the restored session').toBe(nick);

      const query = await askMask(revived, `MODE ${nick}`);
      expect(masks(query), 'MODE <me> after a restart reports the oper\'s own mask')
        .toEqual([MASK]);

      await cleanup(revived, nick);
    }, 180_000);
});
