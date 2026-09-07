import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  uniqueNick,
  getCaps,
  X3Client,
  PRIMARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Strict presence at sub-second resolution.
 *
 * Presence intervals used to be whole seconds with inclusive edges while
 * rows carry millisecond stamps, so a message sent in the SAME second as
 * a user's JOIN -- but before it -- counted as seen, and a message sent
 * in the same second as a PART -- but after it -- did too.  The old
 * tests hid this by spacing joins a full second from the surrounding
 * messages.  This one does the opposite: the witness speaks and the
 * user joins with no delay in between, so the two events almost always
 * share a wall-clock second, and the pre-join message must still be
 * hidden.  Symmetrically for a message sent right after a PART.
 */

async function createOperClient(): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('ssoper'));
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
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(getCaps('chathistory'));
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  c.clearRawBuffer();
  return c;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function batchLines(c: X3Client, cmd: string, timeoutMs = 8000): Promise<string[]> {
  c.clearRawBuffer();
  c.send(cmd);
  const opener = await c.waitForLine(/BATCH \+\S+ chathistory/i, timeoutMs);
  const id = opener.match(/BATCH \+(\S+) chathistory/i)?.[1] ?? '';
  await c.waitForLine(new RegExp(`BATCH -${esc(id)}`), timeoutMs);
  return (c as unknown as { lines: { raw: string }[] }).lines
    .map(l => l.raw).filter(l => l.includes(`batch=${id}`) && l.includes('PRIVMSG'));
}

describe('strict presence is exact below one second', () => {
  let oper: RawSocketClient | null = null;
  let w: X3Client | null = null;
  let u: X3Client | null = null;

  beforeAll(async () => {
    oper = await createOperClient();
    await setStrictPresence(oper, true);
    w = await connectClient('ssw');
    u = await connectClient('ssu');
  });

  afterAll(async () => {
    for (const c of [w, u]) {
      if (!c) continue;
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    if (oper) {
      try { await setStrictPresence(oper, false); } catch { /* */ }
      try { oper.send('QUIT'); } catch { /* */ }
      try { oper.close(); } catch { /* */ }
    }
  });

  it('a message sent in the same second as the join, before it, stays hidden', async () => {
    const channel = uniqueChannel('subsec');
    w!.send(`JOIN ${channel}`);
    await w!.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 200));

    // The witness speaks and U joins back-to-back: same second, almost
    // always.  Order on the server is fixed by the single event loop.
    const before = `before-${uniqueId().slice(0, 8)}`;
    w!.send(`PRIVMSG ${channel} :${before}`);
    u!.send(`JOIN ${channel}`);
    await u!.waitForJoin(channel);
    const after = `after-${uniqueId().slice(0, 8)}`;
    w!.send(`PRIVMSG ${channel} :${after}`);
    await u!.waitForLine(new RegExp(esc(after)), 5000);
    await new Promise(r => setTimeout(r, 400));

    const lines = await batchLines(u!, `CHATHISTORY LATEST ${channel} * 10`);
    const joined = lines.join('\n');
    expect(joined, 'the message after the join is visible').toContain(after);
    expect(joined, 'the message before the join leaked (same-second boundary)').not.toContain(before);
  });

  it('a message sent in the same second as the part, after it, stays hidden', async () => {
    const channel = uniqueChannel('subsecp');
    w!.send(`JOIN ${channel}`);
    await w!.waitForJoin(channel);
    u!.send(`JOIN ${channel}`);
    await u!.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 200));

    const seen = `seen-${uniqueId().slice(0, 8)}`;
    w!.send(`PRIVMSG ${channel} :${seen}`);
    await u!.waitForLine(new RegExp(esc(seen)), 5000);

    // U parts and the witness speaks back-to-back: same second.
    const missed = `missed-${uniqueId().slice(0, 8)}`;
    u!.send(`PART ${channel}`);
    await u!.waitForPart(channel);
    w!.send(`PRIVMSG ${channel} :${missed}`);
    await new Promise(r => setTimeout(r, 400));

    // Rejoin to regain the access gate, then query.
    u!.send(`JOIN ${channel}`);
    await u!.waitForJoin(channel);
    await new Promise(r => setTimeout(r, 300));

    const lines = await batchLines(u!, `CHATHISTORY LATEST ${channel} * 10`);
    const joined = lines.join('\n');
    expect(joined, 'the message seen before the part is visible').toContain(seen);
    expect(joined, 'the message after the part leaked (same-second boundary)').not.toContain(missed);
  });
});
