/**
 * +L pairs with +l (PR #108 follow-ups, 2026-09-07).
 *
 * The redirect fires on `users >= limit`.  Two places cleared or could
 * clear the limit while leaving the redirect:
 *
 *  1. sub1_from_channel(): when a non-+z channel empties, the anti-lockout
 *     reset cleared +i and +l but left +L.  With the limit at 0 and the
 *     channel empty, 0 >= 0 held and the surviving +L became an
 *     UNCONDITIONAL redirect: every joiner, the founder included, was sent
 *     away from their own empty channel.
 *  2. CLEARMODE had no 'L' at all, and its default control string cleared
 *     the limit without the redirect.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, SECONDARY_SERVER, IRC_OPER, uniqueChannel, uniqueNick } from '../helpers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* A plain oper, NOT createOperClient: that helper also authenticates as the
 * shared X3 admin account, and if an earlier suite left that account
 * connected the new client lands as a bouncer ALIAS whose membership does
 * not count toward the limit (users stays 0, 0 >= 1 is false, no redirect). */
async function createOperOn(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const client = await createRawSocketClient(server.host, server.port);
  await client.capLs(); client.capEnd();
  client.register(uniqueNick('wop'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 8000);
  return client;
}

async function user(nick: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs(); c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

describe('+L is cleared with +l', () => {
  const clients: RawSocketClient[] = [];
  afterEach(() => { for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0; });

  it('an emptied non-persistent channel does not redirect its next joiner', async () => {
    const chan = uniqueChannel('redir');
    const dest = uniqueChannel('dest');
    const oper = await createOperOn(PRIMARY_SERVER);
    clients.push(oper);
    // The anti-lockout reset is only observable when an emptied channel is
    // kept for a while (ZANNELS); off, the channel is destroyed outright.
    oper.send('SET ZANNELS TRUE');
    await sleep(300);
    try {
    oper.send(`JOIN ${chan}`); await oper.waitForJoin(chan);
    // A limit of 1 with a redirect: the second joiner is sent to dest (sanity).
    oper.send(`MODE ${chan} +l 1`);
    oper.send(`MODE ${chan} +L ${dest}`);
    await sleep(500);
    const second = await user(uniqueNick('rsec'));
    clients.push(second);
    await sleep(500);
    second.send(`JOIN ${chan}`);
    const r = await second.waitForParsedLine(m => m.command === '490' || m.command === '551' || m.command === 'JOIN', 5000);
    expect(r.command, 'overflow joiner is redirected').toBe('490');
    expect(r.raw).toContain(dest);
    second.send(`PART ${dest}`);
    await sleep(200);

    // Everyone leaves: the channel empties and the anti-lockout reset runs.
    oper.send(`PART ${chan}`);
    await sleep(800);

    // The next joiner must land IN the channel, not be redirected.
    const again = await user(uniqueNick('ragn'));
    clients.push(again);
    await sleep(500);
    again.send(`JOIN ${chan}`);
    const j = await again.waitForParsedLine(m => m.command === '490' || m.command === '551' || m.command === 'JOIN', 5000);
    expect(j.command, 'no redirect on the emptied channel').toBe('JOIN');
    expect(j.params[0]?.toLowerCase()).toBe(chan.toLowerCase());
    again.send(`MODE ${chan}`);
    const modes = await again.waitForNumeric('324', 5000);
    expect(modes.raw, 'no +L left').not.toMatch(/\+\S*L/);
    } finally {
      oper.send('SET ZANNELS FALSE');
      await sleep(200);
    }
  });

  it('CLEARMODE clears the redirect, by default and by letter', async () => {
    const chan = uniqueChannel('clr');
    const dest = uniqueChannel('cdest');
    const oper = await createOperOn(PRIMARY_SERVER);
    clients.push(oper);
    oper.send(`JOIN ${chan}`); await oper.waitForJoin(chan);
    oper.send(`MODE ${chan} +l 5`);
    oper.send(`MODE ${chan} +L ${dest}`);
    await sleep(500);
    oper.send(`MODE ${chan}`);
    let m = await oper.waitForNumeric('324', 5000);
    expect(m.raw).toMatch(/\+\S*L/);

    // By letter.
    const c0 = oper.allLines.length;
    oper.send(`CLEARMODE ${chan} L`);
    await oper.waitForLine(/ MODE \S+ -L/, 5000);
    expect(oper.allLines.slice(c0).some(l => / MODE \S+ -L/.test(l)), 'a -L mode change is broadcast').toBe(true);
    oper.send(`MODE ${chan}`);
    m = await oper.waitForNumeric('324', 5000);
    expect(m.raw, 'redirect gone, limit kept').toMatch(/\+\S*l/);
    expect(m.raw).not.toMatch(/\+\S*L/);

    // By default: CLEARMODE with no control string clears the pair.
    oper.send(`MODE ${chan} +L ${dest}`);
    await sleep(300);
    oper.send(`CLEARMODE ${chan}`);
    await oper.waitForLine(/ MODE \S+ -\S*L/, 5000);
    oper.send(`MODE ${chan}`);
    m = await oper.waitForNumeric('324', 5000);
    expect(m.raw).not.toMatch(/\+\S*[lL]/);
  });
});

/**
 * PR #108 itself: a burst wipeout (the newer side of a split loses to the
 * older channel on relink) used to clear every mode EXCEPT +l and +L,
 * which were enforced straight off the stored values.  Built on the
 * linked bed's split/heal pattern (chathistory-fed-between-pm).
 */

async function splitLeaf(operPrimary: RawSocketClient, operSecondary: RawSocketClient): Promise<void> {
  operPrimary.send('SQUIT leaf.fractalrealities.net :burst wipeout test');
  let splitSeen = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    operSecondary.clearRawBuffer();
    operSecondary.send('LINKS');
    try { await operSecondary.waitForLine(/testnet\.fractalrealities\.net/i, 1500); }
    catch { splitSeen = true; break; }
  }
  expect(splitSeen, 'secondary never registered the split').toBe(true);
}

async function healLeaf(operPrimary: RawSocketClient): Promise<void> {
  operPrimary.send('CONNECT leaf.fractalrealities.net');
  let healed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    operPrimary.clearRawBuffer();
    operPrimary.send('LINKS');
    try { await operPrimary.waitForLine(/leaf\.fractalrealities\.net/i, 1500); healed = true; break; }
    catch { /* */ }
  }
  expect(healed, 'link did not re-establish after CONNECT').toBe(true);
  await sleep(2500);
}

describe('burst wipeout clears +l and +L (PR #108)', () => {
  const clients: RawSocketClient[] = [];
  afterEach(() => { for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0; });

  it('the losing side of a split drops its redirect with its other modes', async () => {
    const chan = uniqueChannel('wipe');
    const dest = uniqueChannel('wdest');
    const operP = await createOperOn(PRIMARY_SERVER);
    const operS = await createOperOn(SECONDARY_SERVER);
    clients.push(operP, operS);

    await splitLeaf(operP, operS);
    try {
      // Older channel on the primary (no modes) ...
      operP.send(`JOIN ${chan}`); await operP.waitForJoin(chan);
      await sleep(1500);   // ... then a NEWER one on the split leaf, with the pair set.
      operS.send(`JOIN ${chan}`); await operS.waitForJoin(chan);
      operS.send(`MODE ${chan} +l 1`);
      operS.send(`MODE ${chan} +L ${dest}`);
      await sleep(500);
      operS.send(`MODE ${chan}`);
      const before = await operS.waitForNumeric('324', 5000);
      expect(before.raw, 'leaf side has +l +L before the heal').toMatch(/\+\S*L/);
    } finally {
      await healLeaf(operP);
    }

    // The leaf's newer channel was wiped by the burst: no +l, no +L, and a
    // joiner on the leaf lands in the channel instead of being redirected.
    operS.send(`MODE ${chan}`);
    const after = await operS.waitForNumeric('324', 5000);
    expect(after.raw, 'wipeout cleared the limit').not.toMatch(/\+\S*l/);
    expect(after.raw, 'wipeout cleared the redirect').not.toMatch(/\+\S*L/);

    const joiner = await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    clients.push(joiner);
    await joiner.capLs(); joiner.capEnd(); joiner.register(uniqueNick('wj'));
    await joiner.waitForNumeric('001'); await sleep(500);
    joiner.send(`JOIN ${chan}`);
    const j = await joiner.waitForParsedLine(m => m.command === '490' || m.command === '551' || m.command === 'JOIN', 5000);
    expect(j.command, 'no redirect after the wipeout').toBe('JOIN');
  });
});
