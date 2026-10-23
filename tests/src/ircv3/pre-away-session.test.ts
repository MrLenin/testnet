import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  authenticateSaslPlain,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  disconnectAbruptly,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  isSecondaryServerAvailable,
} from '../helpers/index.js';

/**
 * draft/pre-away on a bouncer session (Seance PR #121 server notes, 2026-10-19).
 *
 * 1. A held session revived by a socket that sent `AWAY *` before CAP END:
 *    the revive branch of register_user() returned before the pre-away
 *    block, so the revived user stayed present.
 * 2. A pre-registration `AWAY *` is the connection's OWN away state; the
 *    fresh path applied it and then zeroed con_pre_away, which the session
 *    aggregation reads, so once an alias came and went the primary was
 *    aggregated as present.
 */
describe('draft/pre-away on a bouncer session', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) { try { c.close(); } catch { /* closed */ } }
    clients.length = 0;
    for (const a of poolAccounts) await releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  /** A SASL connection that says AWAY <arg> before CAP END (draft/pre-away). */
  async function connectPreAway(account: string, password: string, nick: string, awayArg = '*') {
    const c = track(await createRawSocketClient());
    await c.capLs();
    await c.capReq(['sasl', 'away-notify', 'draft/pre-away']);
    const r = await authenticateSaslPlain(c, account, password);
    if (!r.success) throw new Error(`SASL failed: ${r.error}`);
    c.send(`AWAY ${awayArg}`);
    c.capEnd();
    c.register(nick);
    const welcome = await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));
    return { client: c, nick: welcome.params[0] || nick };
  }

  async function observer(host = PRIMARY_SERVER.host, port = PRIMARY_SERVER.port): Promise<RawSocketClient> {
    const o = track(await createRawSocketClient(host, port));
    await o.capLs();
    o.capEnd();
    o.register(uniqueNick('obs'));
    await o.waitForNumeric('001');
    return o;
  }

  /** WHOIS and report whether RPL_AWAY (301) came before the 318. */
  async function whoisAway(o: RawSocketClient, nick: string): Promise<boolean> {
    o.clearRawBuffer();
    o.send(`WHOIS ${nick}`);
    const first = await o.waitForParsedLine(
      m => m.command === '301' || m.command === '318', 5000,
    );
    if (first.command === '301') await o.waitForNumeric('318', 5000);
    return first.command === '301';
  }

  /** WHOIS and return the RPL_AWAY text, or null when the user shows present. */
  async function whoisAwayText(o: RawSocketClient, nick: string): Promise<string | null> {
    o.clearRawBuffer();
    o.send(`WHOIS ${nick}`);
    const first = await o.waitForParsedLine(
      m => m.command === '301' || m.command === '318', 5000,
    );
    if (first.command !== '301') return null;
    await o.waitForNumeric('318', 5000);
    return first.params[first.params.length - 1];
  }

  it('a pre-registration AWAY * on the reviving socket is applied to the revived session', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('pawr');

    const { client: first, nick: target } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    track(first);
    expect(await bouncerEnableHold(first)).toBe(true);

    const o = await observer();
    expect(await whoisAway(o, target), 'present before the hold').toBe(false);

    disconnectAbruptly(first);
    clients.splice(clients.indexOf(first), 1);
    await new Promise(r => setTimeout(r, 1500));

    const { client: second, nick: revived } = await connectPreAway(
      account.account, account.password, target,
    );
    expect(revived.toLowerCase()).toBe(target.toLowerCase());

    expect(await whoisAway(o, target), 'the revived user said AWAY * before CAP END').toBe(true);

    await bouncerDisableHold(second);
  });

  it('a pre-registration AWAY * is the connection\'s own state: it outlives an alias that came and went', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const { client: primary, nick } = await connectPreAway(
      account.account, account.password, uniqueNick('pawa'),
    );
    expect(await bouncerEnableHold(primary)).toBe(true);

    const o = await observer();
    expect(await whoisAway(o, nick), 'away-star alone is away').toBe(true);

    // A present alias attaches: present wins.
    const { client: alias } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    track(alias);
    await new Promise(r => setTimeout(r, 500));
    expect(await whoisAway(o, nick), 'a present alias makes the session present').toBe(false);

    // The alias leaves: the primary's own AWAY * must count again.
    alias.send('QUIT :bye');
    clients.splice(clients.indexOf(alias), 1);
    await new Promise(r => setTimeout(r, 1500));
    expect(await whoisAway(o, nick), 'the primary\'s own AWAY * after the alias left').toBe(true);

    await bouncerDisableHold(primary);
  });
  it('a pre-registration AWAY reaches the other servers', async () => {
    if (!(await isSecondaryServerAvailable())) return;
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const { client, nick } = await connectPreAway(
      account.account, account.password, uniqueNick('pawx'), ':prereg brb',
    );
    const remote = await observer(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    await new Promise(r => setTimeout(r, 1000));
    expect(await whoisAwayText(remote, nick),
      'a server that only learned of the user by the network introduction must see the away').toBe('prereg brb');
    client.send('QUIT');
  });

  it('an alias that attaches with a pre-registration AWAY counts in the session', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const { client: primary, nick } = await createSaslBouncerClient(
      account.account, account.password, { nick: uniqueNick('pawl') },
    );
    track(primary);
    expect(await bouncerEnableHold(primary)).toBe(true);
    primary.send('AWAY *');
    await primary.waitForNumeric('306', 5000);

    // The alias says it is away with a message before CAP END; one AWAY
    // with a message plus one AWAY * aggregates to AWAY with that message.
    await connectPreAway(account.account, account.password, nick, ':on the phone');
    const o = await observer();
    await new Promise(r => setTimeout(r, 1000));
    expect(await whoisAwayText(o, nick), 'the alias\'s own pre-registration away').toBe('on the phone');

    await bouncerDisableHold(primary);
  });
});
