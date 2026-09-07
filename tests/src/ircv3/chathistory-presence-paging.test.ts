import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  uniqueNick,
  getCaps,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Strict presence must page over VISIBLE rows, not raw rows.
 *
 * The filter used to run after the store had already filled a page:
 * with limit N, the N raw rows nearest the reference were fetched and
 * only then filtered, so a page dominated by rows the caller was absent
 * for shrank (or emptied) while older/newer visible rows never made it
 * into any page.  Worse, a full raw page that filtered to nothing was
 * reported INCOMPLETE (no draft/chathistory-end) with no cursor -- the
 * client could neither see the rows nor page past the gap (prod field
 * report 2026-09-02: a wide BETWEEN on #linux returned an empty batch).
 *
 * Scenario (built once): U joins; W sends 3 (visible); U parts; W sends
 * 12 (invisible to U); U rejoins; W sends 2 (visible).  Presence
 * coalesces a part/rejoin gap of <=30s into one interval, so the absence
 * is held for 32s.
 *
 * U is an ACCOUNT (pool) user: on the linked bed the leaf stores every
 * channel it sees, so a short local page federates, and only an account
 * requester (presence replicates by observation) gets the responder-side
 * walk that makes the remote truncation flag -- and therefore the end
 * tag -- trustworthy.  A pool account carries a bouncer session, whose
 * PART is not echoed like a plain part: the scenario settles on time
 * instead of waiting for the echo (same as chathistory-strict-presence).
 *
 * Limits: JOIN/PART event rows are stored but, without
 * draft/event-playback, are skipped INSIDE the walk (uncounted, since
 * 2026-09-06; before that they counted toward the limit and were only
 * dropped at send time, so a run of them longer than the limit handed a
 * client an empty page with messages still behind it).  U's visible
 * PRIVMSG rows are 5 (3 early + 2 late).  A limit of 10 exceeds that
 * (every visible row fits, end tag expected) yet stays below the
 * invisible run plus the visible tail (12 + 3), so the pre-fix raw page
 * could never reach the older visible rows.
 */

const GAP_MS = 32 * 1000;
const LIMIT = 10;

async function createOperClient(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const client = await createRawSocketClient(server.host, server.port);
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('ppoper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function setStrictPresence(operClient: RawSocketClient, value: boolean): Promise<void> {
  operClient.send(`SET CHATHISTORY_STRICT_PRESENCE ${value ? 'TRUE' : 'FALSE'}`);
  await new Promise(r => setTimeout(r, 300));
}

async function connectClient(prefix: string): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await client.capLs();
  await client.capReq(getCaps('chathistory'));
  client.capEnd();
  client.register(uniqueNick(prefix));
  await client.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 400));
  client.clearRawBuffer();
  return client;
}

async function sendRun(w: X3Client, channel: string, tag: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${tag}${i}-${uniqueId().slice(0, 6)}`;
    ids.push(id);
    w.send(`PRIVMSG ${channel} :${id}`);
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 400));
  return ids;
}

function countOf(lines: string[], ids: string[]): number {
  const joined = lines.join('\n');
  return ids.filter(id => joined.includes(id)).length;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Raw query capturing the whole batch so the end tag can be inspected. */
async function rawQuery(c: X3Client, cmd: string, timeoutMs = 8000): Promise<{ lines: string[]; endTag: boolean }> {
  c.clearRawBuffer();
  c.send(cmd);
  const opener = await c.waitForLine(/BATCH \+\S+ chathistory/i, timeoutMs);
  const m = opener.match(/BATCH \+(\S+) chathistory/i);
  const id = m ? m[1] : '';
  await c.waitForLine(new RegExp(`BATCH -${esc(id)}`), timeoutMs);
  const raw = (c as unknown as { lines: { raw: string }[] }).lines.map(l => l.raw);
  const lines = raw.filter(l => l.includes(`batch=${id}`) && l.includes('PRIVMSG'));
  return { lines, endTag: /draft\/chathistory-end/.test(opener) };
}

function msgidOf(line: string): string | undefined {
  return line.match(/msgid=([^; ]+)/)?.[1];
}

describe('strict presence pages over visible rows', () => {
  // Strict presence is a per-server feature (SET is local): the leaf
  // must have it on too, both to RECORD U's presence as it observes the
  // joins/parts and to filter as a responder.
  let oper: RawSocketClient | null = null;
  let operLeaf: RawSocketClient | null = null;
  let w: X3Client | null = null;
  let u: X3Client | null = null;
  let poolAccount: string | null = null;
  let channel = '';
  let early: string[] = [];
  let hidden: string[] = [];
  let late: string[] = [];
  let tStart = '';
  let tEnd = '';

  beforeAll(async () => {
    oper = await createOperClient(PRIMARY_SERVER);
    await setStrictPresence(oper, true);
    operLeaf = await createOperClient(SECONDARY_SERVER);
    await setStrictPresence(operLeaf, true);

    w = await connectClient('ppw');
    u = await connectClient('ppu');
    const { account, fromPool } = await setupTestAccount(u);
    if (fromPool) poolAccount = account;

    channel = uniqueChannel('ppage');
    tStart = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, '.000Z');
    w.send(`JOIN ${channel}`);
    await w.waitForJoin(channel);
    // Keep W's JOIN row out of U's first presence second.
    await new Promise(r => setTimeout(r, 1500));
    u.send(`JOIN ${channel}`);
    await u.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    early = await sendRun(w, channel, 'early', 3);

    // Bouncer-session PART: settle on time rather than the echo.
    u.send(`PART ${channel}`);
    await new Promise(r => setTimeout(r, 2500));

    hidden = await sendRun(w, channel, 'hidden', 12);

    // Hold the absence past the 30s reconnect-coalescing window.
    await new Promise(r => setTimeout(r, GAP_MS));
    u.send(`JOIN ${channel}`);
    await u.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 1200));

    late = await sendRun(w, channel, 'late', 2);
    tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
  }, 90000);

  afterAll(async () => {
    if (u) {
      // Don't leave a held bouncer session on the pool account.
      try { await bouncerDisableHold(u); } catch { /* */ }
    }
    for (const c of [w, u]) {
      if (!c) continue;
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    if (poolAccount) releaseTestAccount(poolAccount);
    for (const o of [oper, operLeaf]) {
      if (!o) continue;
      try { await setStrictPresence(o, false); } catch { /* */ }
      try { o.send('QUIT'); } catch { /* */ }
      try { o.close(); } catch { /* */ }
    }
  });

  it('LATEST fills the page from older visible rows past an invisible run', async () => {
    const { lines, endTag } = await rawQuery(u!, `CHATHISTORY LATEST ${channel} * ${LIMIT}`);
    expect(countOf(lines, hidden), 'hidden rows leaked').toBe(0);
    expect(countOf(lines, late), 'recent visible rows').toBe(2);
    expect(countOf(lines, early), 'older visible rows must fill the page').toBe(3);
    expect(endTag, 'all visible rows fit: page must carry draft/chathistory-end').toBe(true);
  });

  it('BETWEEN over the whole window returns the visible rows, complete', async () => {
    const { lines, endTag } = await rawQuery(
      u!, `CHATHISTORY BETWEEN ${channel} timestamp=${tStart} timestamp=${tEnd} ${LIMIT}`);
    expect(countOf(lines, hidden), 'hidden rows leaked').toBe(0);
    expect(countOf(lines, early), 'early visible rows').toBe(3);
    expect(countOf(lines, late), 'late visible rows').toBe(2);
    expect(endTag, 'window exhausted: page must carry draft/chathistory-end').toBe(true);
  });

  it('BEFORE the newest row pages back across the invisible run', async () => {
    const newest = await rawQuery(u!, `CHATHISTORY LATEST ${channel} * 1`);
    const msgid = msgidOf(newest.lines[0] ?? '');
    expect(msgid, 'newest visible row carries a msgid').toBeTruthy();
    const { lines } = await rawQuery(u!, `CHATHISTORY BEFORE ${channel} msgid=${msgid} ${LIMIT}`);
    expect(countOf(lines, hidden), 'hidden rows leaked').toBe(0);
    // The visible PRIVMSG rows before the newest: late0 + early0..2.
    expect(countOf(lines, late) + countOf(lines, early), 'four visible rows').toBe(4);
  });

  it('a client that stops only on an empty page (no end-tag support) still reaches every visible row', async () => {
    // The pre-May-2026 spec pseudocode: BEFORE <oldest of the page> with a
    // small limit until a page comes back EMPTY. With presence filtering
    // the walk must never hand such a client an empty page while visible
    // rows remain behind a gap -- it seeks past the gap instead. Here the
    // 12-row hidden run sits between the visible pages.
    const seen: string[] = [];
    let ref = (await rawQuery(u!, `CHATHISTORY LATEST ${channel} * 2`)).lines;
    let pages = 0;
    for (;;) {
      seen.push(...ref.map(l => l.replace(/^.* :/, '')));
      if (ref.length === 0 || ++pages > 10) break;
      const oldest = msgidOf(ref[0]);
      expect(oldest, 'every returned row carries a msgid').toBeTruthy();
      ref = (await rawQuery(u!, `CHATHISTORY BEFORE ${channel} msgid=${oldest} 2`)).lines;
    }
    expect(pages, 'the walk ends on an empty page').toBeLessThanOrEqual(10);
    expect(countOf(seen, hidden), 'hidden rows leaked').toBe(0);
    expect(countOf(seen, late), 'both late rows').toBe(2);
    expect(countOf(seen, early), 'all three early rows, behind the gap').toBe(3);
  });

  it('AFTER the first visible row pages forward across the invisible run', async () => {
    const all = await rawQuery(u!, `CHATHISTORY LATEST ${channel} * ${LIMIT}`);
    const firstLine = all.lines.find(l => l.includes(early[0])) ?? '';
    const msgid = msgidOf(firstLine);
    expect(msgid, 'first visible row is reachable and carries a msgid').toBeTruthy();
    const { lines } = await rawQuery(u!, `CHATHISTORY AFTER ${channel} msgid=${msgid} ${LIMIT}`);
    expect(countOf(lines, hidden), 'hidden rows leaked').toBe(0);
    expect(countOf(lines, early), 'remaining early rows').toBe(2);
    expect(countOf(lines, late), 'late rows reached across the gap').toBe(2);
  });
});
