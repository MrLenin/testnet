import { describe, it, expect, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueNick,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * Two federation completeness properties (spec-merge audit backlog):
 *
 * 1. TARGETS window veto: #565 latest-message matching is a
 *    NETWORK-WIDE property. A server whose local latest for a target
 *    sits inside the requested window must not list the target when
 *    another server holds a newer latest outside the window. Remote
 *    responders now return out-of-window-high latests as veto rows
 *    (include_newer) and the requester re-filters after the merge.
 *
 * 2. Remote-only context children (#526): a reaction stored only on a
 *    remote server (sent during a split) must reach the requester
 *    when its PARENT is in the requested page, even though the
 *    child's own timestamp is outside it. Responders attach context
 *    before emitting and declare children via CH C; requesters splice
 *    them after their parents, uncounted.
 *
 * Both use the proven netsplit pattern: what is said while the leaf is
 * split exists only on the far server, so the near server can only see
 * it through federation.
 */

const clients: Array<{ close: () => void }> = [];

// RawSocketClient keeps its received lines private; reach in for raw scans.
const rawOf = (c: unknown): string[] =>
  (c as { lines: { raw: string }[] }).lines.map(l => l.raw);

let operPrimary: RawSocketClient | null = null;
let splitOpen = false;

function track<T extends { close: () => void }>(c: T): T {
  clients.push(c);
  return c;
}

async function createOperOn(server: typeof PRIMARY_SERVER): Promise<RawSocketClient> {
  const client = track(await createRawSocketClient(server.host, server.port));
  await client.capLs();
  client.capEnd();
  client.register(uniqueNick('fwoper'));
  await client.waitForNumeric('001');
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

async function mkAuthed(server: typeof PRIMARY_SERVER, prefix: string): Promise<{
  c: X3Client; account: string; fromPool: boolean;
}> {
  const c = track(new X3Client());
  await c.connect(server.host, server.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags',
                  'draft/event-playback', 'echo-message']);
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 400));
  c.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(c);
  return { c, account, fromPool };
}

async function splitLeaf(opPrimary: RawSocketClient, opSecondary: RawSocketClient): Promise<void> {
  opPrimary.send('SQUIT leaf.fractalrealities.net :fed window/context test');
  splitOpen = true;
  let splitSeen = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    opSecondary.clearRawBuffer();
    opSecondary.send('LINKS');
    try {
      await opSecondary.waitForLine(/testnet\.fractalrealities\.net/i, 1500);
    } catch { splitSeen = true; break; }
  }
  expect(splitSeen, 'secondary never registered the split').toBe(true);
}

async function healLeaf(opPrimary: RawSocketClient): Promise<void> {
  opPrimary.send('CONNECT leaf.fractalrealities.net');
  let healed = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    opPrimary.clearRawBuffer();
    opPrimary.send('LINKS');
    try {
      await opPrimary.waitForLine(/leaf\.fractalrealities\.net/i, 1500);
      healed = true;
      break;
    } catch { /* retry */ }
  }
  splitOpen = false;
  expect(healed, 'link did not re-establish after CONNECT').toBe(true);
  await new Promise(r => setTimeout(r, 2000));
}

afterAll(async () => {
  // Never leave the bed split, even on assertion failure mid-test.
  if (splitOpen && operPrimary) {
    try { await healLeaf(operPrimary); } catch { /* best effort */ }
  }
  for (const c of clients) { try { c.close(); } catch { /* */ } }
});

describe('federated TARGETS window veto + remote-only context children', () => {
  it('vetoes out-of-window targets network-wide and splices split-born reactions', async () => {
    const channel = uniqueChannel('fedwc');
    operPrimary = await createOperOn(PRIMARY_SERVER);
    const operSecondary = await createOperOn(SECONDARY_SERVER);

    const t0 = new Date(Date.now() - 5000).toISOString();

    const a = await mkAuthed(PRIMARY_SERVER, 'fwa');
    const b = await mkAuthed(SECONDARY_SERVER, 'fwb');
    for (const { c } of [a, b]) {
      c.send(`JOIN ${channel}`);
      await c.waitForLine(new RegExp(`JOIN\\s+:?${channel}`, 'i'), 5000);
    }
    await new Promise(r => setTimeout(r, 500));

    // Parent message, replicated to both stores pre-split.
    b.c.clearRawBuffer();
    a.c.send(`PRIVMSG ${channel} :parent message`);
    const delivered = await b.c.waitForLine(/PRIVMSG.*parent message/, 8000);
    const midMatch = delivered.match(/msgid=([^;\s]+)/);
    expect(midMatch, 'parent delivery to the far server must carry a msgid').toBeTruthy();
    const parentMsgid = midMatch![1];

    // Window boundary strictly after the parent.
    await new Promise(r => setTimeout(r, 1600));
    const tMid = new Date().toISOString();
    await new Promise(r => setTimeout(r, 1600));

    await splitLeaf(operPrimary, operSecondary);

    // Split-born, far-side-only: a newer channel message (pushes the
    // network-wide latest past tMid) and a reaction to the parent.
    b.c.send(`PRIVMSG ${channel} :split-born newer message`);
    await new Promise(r => setTimeout(r, 300));
    b.c.send(`@+draft/reply=${parentMsgid};+draft/react=👍 TAGMSG ${channel}`);
    await new Promise(r => setTimeout(r, 800));

    await healLeaf(operPrimary);

    // --- 1. Remote-only context child --------------------------------
    // Page BEFORE tMid contains the parent but not the reaction (its
    // own timestamp is after tMid, and it exists only on the far
    // server). It must arrive spliced as a context child.
    //
    // The SQUIT de-advertises the leaf as a storage server, and the
    // re-advertisement only lands ~30s after the heal — until then,
    // federated queries legitimately skip it. Poll the BEFORE query
    // until the leaf answers (the reaction appears); this also serves
    // as the federation-readiness gate for the TARGETS assertion.
    let reactLine: string | undefined;
    for (let attempt = 0; attempt < 15 && !reactLine; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 4000));
      a.c.clearRawBuffer();
      a.c.send(`CHATHISTORY BEFORE ${channel} timestamp=${tMid} 50`);
      await a.c.waitForLine(/BATCH -\S+/, 15000);
      reactLine = rawOf(a.c).find(l => /TAGMSG/.test(l) && /draft\/react/.test(l));
    }
    const replay = rawOf(a.c).join('\n');
    expect(replay, 'page must include the parent').toMatch(/parent message/);
    expect(reactLine,
      'remote-only reaction must federate as a context child').toBeTruthy();
    expect(reactLine!, 'spliced child must carry the context tag')
      .toMatch(/draft\/chathistory-context/);

    // --- 2. TARGETS window veto -------------------------------------
    // Window [t0, tMid]: the near server's local latest (the parent)
    // is inside it, but the network-wide latest (the split-born
    // message, far side only) is beyond tMid — the channel must NOT
    // be listed. Federation to the leaf is known live (gate above).
    a.c.clearRawBuffer();
    a.c.send(`CHATHISTORY TARGETS timestamp=${t0} timestamp=${tMid} 50`);
    await a.c.waitForLine(/BATCH -\S+/, 15000);
    const targetRows = rawOf(a.c).filter(l => /CHATHISTORY TARGETS /.test(l));
    const chanRow = targetRows.find(l => l.toLowerCase().includes(channel.toLowerCase()));
    expect(chanRow,
      `network-wide latest is outside the window; got row: ${chanRow}`).toBeUndefined();
  }, 180000);
});
