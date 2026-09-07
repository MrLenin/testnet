import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  uniqueChannel,
  uniqueId,
  uniqueNick,
  X3Client,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
} from '../helpers/index.js';

/**
 * A message has ONE time.
 *
 * The live @time a client receives for a message that crossed a server
 * link is the origin's stamp (the S2S tag).  The history row the
 * receiving server stored for the same msgid used to be stamped with
 * that server's own clock at observation time, so CHATHISTORY replayed
 * the message with a different @time than it was delivered with, the
 * msgid→timestamp index disagreed between servers, and federated merges
 * sorted rows from different servers by clocks that disagreed by the
 * link latency.  JOIN/PART event rows had the same defect.
 *
 * Fix rule: a stored row carries the S2S tag time when the event came
 * over a link, else the local HLC time the msgid was minted with -- the
 * same choice the live delivery path already makes.
 *
 * On a single-host bed the link latency is sub-millisecond, so any ONE
 * pair may agree by coincidence; over a run of messages plus a JOIN and
 * a PART, "every pair agrees" separates the two behaviours reliably.
 */

const RUN = 20;
const CAPS = ['batch', 'server-time', 'message-tags', 'draft/chathistory', 'draft/event-playback', 'echo-message'];

async function connectClient(server: typeof PRIMARY_SERVER, prefix: string): Promise<X3Client> {
  const c = new X3Client();
  await c.connect(server.host, server.port);
  await c.capLs();
  await c.capReq(CAPS);
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 400));
  c.clearRawBuffer();
  return c;
}

function tagOf(line: string, tag: string): string | undefined {
  const m = line.match(new RegExp(`(?:^|[@;])${tag}=([^; ]+)`));
  return m?.[1];
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rawLines(c: X3Client): string[] {
  return (c as unknown as { lines: { raw: string }[] }).lines.map(l => l.raw);
}

/** Run a CHATHISTORY query and return every line inside its batch. */
async function batchLines(c: X3Client, cmd: string, timeoutMs = 8000): Promise<string[]> {
  c.clearRawBuffer();
  c.send(cmd);
  const opener = await c.waitForLine(/BATCH \+\S+ chathistory/i, timeoutMs);
  const id = opener.match(/BATCH \+(\S+) chathistory/i)?.[1] ?? '';
  await c.waitForLine(new RegExp(`BATCH -${esc(id)}`), timeoutMs);
  return rawLines(c).filter(l => l.includes(`batch=${id}`));
}

describe('chathistory replays the time a message was delivered with', () => {
  let a: X3Client | null = null;   // on the primary: sender
  let b: X3Client | null = null;   // on the leaf: observer + querier
  let channel = '';
  const live = new Map<string, { time: string; kind: string }>();  // msgid -> live tag

  beforeAll(async () => {
    b = await connectClient(SECONDARY_SERVER, 'tcb');
    a = await connectClient(PRIMARY_SERVER, 'tca');

    channel = uniqueChannel('tconsist');
    b.send(`JOIN ${channel}`);
    await b.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    // A's JOIN, messages and PART all cross the link to B's server.
    b.clearRawBuffer();
    a.send(`JOIN ${channel}`);
    await a.waitForJoin(channel);
    const joinLine = await b.waitForLine(new RegExp(`JOIN :?${esc(channel)}`, 'i'), 5000);
    const joinMsgid = tagOf(joinLine, 'msgid');
    const joinTime = tagOf(joinLine, 'time');
    if (joinMsgid && joinTime) live.set(joinMsgid, { time: joinTime, kind: 'JOIN' });

    for (let i = 0; i < RUN; i++) {
      const id = `tc${i}-${uniqueId().slice(0, 6)}`;
      b.clearRawBuffer();
      a.send(`PRIVMSG ${channel} :${id}`);
      const line = await b.waitForLine(new RegExp(`PRIVMSG ${esc(channel)} :${esc(id)}`), 5000);
      const msgid = tagOf(line, 'msgid');
      const time = tagOf(line, 'time');
      expect(msgid && time, `live line ${i} carries msgid and time: ${line}`).toBeTruthy();
      live.set(msgid!, { time: time!, kind: 'PRIVMSG' });
      await new Promise(r => setTimeout(r, 60));
    }

    b.clearRawBuffer();
    a.send(`PART ${channel} :done`);
    const partLine = await b.waitForLine(new RegExp(`PART ${esc(channel)}`, 'i'), 5000);
    const partMsgid = tagOf(partLine, 'msgid');
    const partTime = tagOf(partLine, 'time');
    if (partMsgid && partTime) live.set(partMsgid, { time: partTime, kind: 'PART' });
    await new Promise(r => setTimeout(r, 500));
  }, 60000);

  afterAll(async () => {
    for (const c of [a, b]) {
      if (!c) continue;
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
  });

  it('every replayed row on the receiving server carries the live @time (messages, JOIN, PART)', async () => {
    const lines = await batchLines(b!, `CHATHISTORY LATEST ${channel} * 100`);
    const replayed = new Map<string, string>();
    for (const l of lines) {
      const msgid = tagOf(l, 'msgid');
      const time = tagOf(l, 'time');
      if (msgid && time) replayed.set(msgid, time);
    }

    const mismatches: string[] = [];
    let compared = 0;
    for (const [msgid, { time, kind }] of live) {
      const got = replayed.get(msgid);
      if (got === undefined) continue;   // absence is a different bug; counted below
      compared++;
      if (got !== time) mismatches.push(`${kind} ${msgid}: live ${time} replayed ${got}`);
    }
    expect(compared, 'replay covered the live rows').toBeGreaterThanOrEqual(RUN);
    expect(live.size, 'JOIN and PART were captured live with msgid+time').toBe(RUN + 2);
    expect(replayed.has([...live.keys()][0]), 'JOIN row replayed (event-playback)').toBe(true);
    expect(mismatches, `rows replayed with a different @time than delivered:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('the sender\'s own server replays the echoed @time', async () => {
    // Local path: echo-message @time vs the row the origin stored.
    const id = `tcecho-${uniqueId().slice(0, 6)}`;
    a!.send(`JOIN ${channel}`);
    await a!.waitForJoin(channel);
    a!.clearRawBuffer();
    a!.send(`PRIVMSG ${channel} :${id}`);
    const echo = await a!.waitForLine(new RegExp(`PRIVMSG ${esc(channel)} :${esc(id)}`), 5000);
    const msgid = tagOf(echo, 'msgid');
    const time = tagOf(echo, 'time');
    expect(msgid && time, `echo carries msgid and time: ${echo}`).toBeTruthy();

    const lines = await batchLines(a!, `CHATHISTORY LATEST ${channel} * 5`);
    const row = lines.find(l => tagOf(l, 'msgid') === msgid);
    expect(row, 'echoed message is in history').toBeTruthy();
    expect(tagOf(row!, 'time'), 'replayed @time equals the echoed @time').toBe(time);
  });
});
