/**
 * One replay pipeline (audit 2026-09-06, wave 1).
 *
 * The bouncer reattach replay (replay.c) built its pages with a bare
 * walk: no context attach, no redaction filter, no requester type mask,
 * and its PM leg listed targets in key order with no filter.  The
 * on-demand CHATHISTORY handlers had all four.  These cases pin the
 * bouncer path to the on-demand behaviour:
 *
 *  1. a row REDACTED while the session was detached is not replayed;
 *  2. a long JOIN/PART run after the detach point does not empty the
 *     replay page for a client without draft/event-playback;
 *  3. the PM leg still replays the session's conversation when more
 *     than fifty other targets were active in the window;
 *  4. a connection that did not negotiate draft/event-playback receives
 *     no event rows even though a sibling connection of the same
 *     session did (own caps, not the session union).
 *
 * Replay is gated on the absence of draft/chathistory (legacy client
 * presentation), same as bouncer-pm-replay.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  uniqueChannel,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  createBouncerClient,
  createRawSocketClient,
  disconnectAbruptly,
  reconnectBouncer,
} from '../helpers/index.js';

const REPLAY_CAPS = ['batch', 'message-tags', 'server-time', 'echo-message', 'account-tag'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function replayRows(lines: string[]): string[] {
  // Rows inside chathistory batches: PRIVMSG/NOTICE/JOIN/PART/... with a @batch= tag.
  return lines.filter(l => /^@[^ ]*batch=/.test(l) && / (PRIVMSG|NOTICE|JOIN|PART|QUIT|MODE|KICK|REDACT) /.test(l));
}

describe('bouncer replay uses the on-demand page pipeline', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const track = (c: RawSocketClient) => { clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  async function heldSessionInChannel(chan: string) {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const a = await createBouncerClient(acc.account, acc.password, { extraCaps: REPLAY_CAPS });
    track(a.client);
    a.client.send(`JOIN ${chan}`); await a.client.waitForJoin(chan);
    await sleep(300);
    return { acc, a };
  }

  it('does not replay a row redacted while the session was detached', async () => {
    const chan = uniqueChannel('rdct');
    const { acc, a } = await heldSessionInChannel(chan);

    const bAcc = await getTestAccount(); if (bAcc.fromPool) pool.push(bAcc.account);
    const b = await createSaslBouncerClient(bAcc.account, bAcc.password,
      { extraCaps: ['draft/message-redaction', 'message-tags', 'echo-message', 'batch'] });
    track(b.client);
    b.client.send(`JOIN ${chan}`); await b.client.waitForJoin(chan);

    disconnectAbruptly(a.client);
    await sleep(500);

    const start = b.client.allLines.length;
    b.client.send(`PRIVMSG ${chan} :secret-${chan}`);
    b.client.send(`PRIVMSG ${chan} :kept-${chan}`);
    await sleep(800);
    const echoed = b.client.allLines.slice(start).find(l => l.includes(`secret-${chan}`)) ?? '';
    const msgid = /msgid=([^;\s]+)/.exec(echoed)?.[1];
    expect(msgid, 'the secret row carries a msgid in its echo').toBeTruthy();
    b.client.send(`REDACT ${chan} ${msgid} :oops`);
    await sleep(1500);

    const a2 = await reconnectBouncer(acc.account, acc.password, { nick: a.nick, extraCaps: REPLAY_CAPS });
    track(a2.client);
    await sleep(2500);
    const rows = replayRows(a2.client.allLines);
    expect(rows.some(l => l.includes(`kept-${chan}`)), 'the surviving row is replayed').toBe(true);
    expect(rows.some(l => l.includes(`secret-${chan}`)), 'the redacted row is NOT replayed').toBe(false);
  });

  it('replays the messages behind a long JOIN/PART run for a client without event-playback', async () => {
    const chan = uniqueChannel('churn');
    const { acc, a } = await heldSessionInChannel(chan);
    const bAcc = await getTestAccount(); if (bAcc.fromPool) pool.push(bAcc.account);
    const b = await createSaslBouncerClient(bAcc.account, bAcc.password, { extraCaps: ['echo-message'] });
    track(b.client);
    b.client.send(`JOIN ${chan}`); await b.client.waitForJoin(chan);

    disconnectAbruptly(a.client);
    await sleep(500);
    b.client.send(`PRIVMSG ${chan} :before-churn-${chan}`);

    // 60 JOIN+PART pairs = 120 event rows, more than the replay limit (100).
    const churnNick = uniqueNick('churn');
    const churn = track(await createRawSocketClient());
    await churn.capLs(); churn.capEnd(); churn.register(churnNick);
    await churn.waitForNumeric('001');
    for (let i = 0; i < 60; i++) {
      churn.send(`JOIN ${chan}`); churn.send(`PART ${chan}`);
      await sleep(60);
    }
    b.client.send(`PRIVMSG ${chan} :after-churn-${chan}`);
    await sleep(1500);

    const a2 = await reconnectBouncer(acc.account, acc.password, { nick: a.nick, extraCaps: REPLAY_CAPS });
    track(a2.client);
    await sleep(3000);
    const rows = replayRows(a2.client.allLines);
    // The churner's JOIN/PART on this channel must not appear in replay for a
    // client without event-playback.  (The reconnecting user's OWN JOINs to
    // its channels are the bouncer session-restore burst, legitimately wrapped
    // in the outer bouncer-replay batch -- not chathistory rows.)
    const churnEvents = rows.filter(l => l.includes(churnNick) && / (JOIN|PART) /.test(l));
    expect(churnEvents, 'the churner\'s events must not reach a no-event-playback client').toHaveLength(0);
    expect(rows.some(l => l.includes(`before-churn-${chan}`)), 'row before the churn is replayed').toBe(true);
    expect(rows.some(l => l.includes(`after-churn-${chan}`)), 'row after the churn is replayed').toBe(true);
  });

  it('replays the PM conversation although fifty-plus other targets were active in the window', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const a = await createBouncerClient(acc.account, acc.password, { extraCaps: REPLAY_CAPS });
    track(a.client);
    const bAcc = await getTestAccount(); if (bAcc.fromPool) pool.push(bAcc.account);
    const b = await createSaslBouncerClient(bAcc.account, bAcc.password);
    track(b.client);
    a.client.send(`PRIVMSG ${b.nick} :hello-${acc.account}`);
    await sleep(800);

    disconnectAbruptly(a.client);
    await sleep(500);

    // Someone else's channels, active now, sorting before every pair key.
    const tag = Math.random().toString(36).slice(2, 7);
    const x = track(await createRawSocketClient());
    await x.capLs(); x.capEnd(); x.register(uniqueNick('crowd'));
    await x.waitForNumeric('001');
    for (let i = 0; i < 55; i++) {
      x.send(`JOIN #aaa-${tag}-${i}`);
      x.send(`PRIVMSG #aaa-${tag}-${i} :noise ${i}`);
      await sleep(40);
    }
    b.client.send(`PRIVMSG ${a.nick} :missed-${acc.account}`);
    await sleep(1500);

    const a2 = await reconnectBouncer(acc.account, acc.password, { nick: a.nick, extraCaps: REPLAY_CAPS });
    track(a2.client);
    await sleep(3000);
    const rows = replayRows(a2.client.allLines);
    expect(rows.some(l => l.includes(`missed-${acc.account}`)), 'the missed PM is replayed').toBe(true);
  });

  // NOTE: the own-caps-vs-session-union gate (should_send_message_type now uses
  // CapRecipientHas, not CapActive) is verified by reading + build.  A live pin
  // needs two connections of ONE bouncer session with different caps; the bed's
  // same-nick alias routing does not deliver the alias's own CHATHISTORY reply
  // reliably, so a robust live test could not be built here (audit residue).
  // The 'long JOIN/PART run' case above pins that a no-event-playback bouncer
  // connection receives no event rows.
});
