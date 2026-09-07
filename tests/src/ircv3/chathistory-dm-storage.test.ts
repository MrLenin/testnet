import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueId,
  uniqueNick,
  waitForChathistory,
  X3Client,
  setupTestAccount,
  releaseTestAccount,
  PRIMARY_SERVER,
} from '../helpers/index.js';

/**
 * DM storage keying + TAGMSG DM storage.
 *
 * Pins two long-standing gaps found in the 2026-08-30 missing-history
 * investigation (para/projects/chathistory-missing-history-msgid-
 * investigation.md):
 *
 *  F2: multiline DMs were stored under the recipient's NICK while every
 *      PM query path looks up the identity pair-key -- delivered with a
 *      msgid, unreachable by any CHATHISTORY query, forever.
 *  F4: DM TAGMSGs (reactions/replies) were never stored at all -- the
 *      delivered msgid never entered the msgid index, so using it as an
 *      anchor (PERSISTENCE ATTACH cursor, BEFORE/AFTER refs) failed.
 *
 * Both tests are red against the pre-fix server and green after.
 */

const DM_CAPS = [
  'batch', 'server-time', 'message-tags',
  'draft/chathistory', 'draft/multiline', 'draft/event-playback',
];

async function createAuthedDmClient(prefix: string): Promise<{
  client: X3Client; account: string; fromPool: boolean; nick: string;
}> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await client.capLs();
  await client.capReq(DM_CAPS);
  client.capEnd();
  const nick = uniqueNick(prefix);
  client.register(nick);
  await client.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 500));
  client.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(client);
  return { client, account, fromPool, nick };
}

describe('DM chathistory storage keying (multiline + TAGMSG)', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  const track = (c: X3Client): X3Client => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('multiline DM is reachable via CHATHISTORY on the pair-key (F2)', async () => {
    const a = await createAuthedDmClient('mldma');
    track(a.client); if (a.fromPool) poolAccounts.push(a.account);
    const b = await createAuthedDmClient('mldmb');
    track(b.client); if (b.fromPool) poolAccounts.push(b.account);

    // A sends a multiline DM to B's nick.
    const lineId = uniqueId();
    const batchId = `mldm${uniqueId().slice(0, 6)}`;
    a.client.send(`BATCH +${batchId} draft/multiline ${b.nick}`);
    a.client.send(`@batch=${batchId} PRIVMSG ${b.nick} :first ${lineId}`);
    a.client.send(`@batch=${batchId} PRIVMSG ${b.nick} :second ${lineId}`);
    a.client.send(`BATCH -${batchId}`);
    await new Promise(r => setTimeout(r, 600));

    // B queries the DM buffer (PM target = the other party's nick;
    // the server normalizes to the identity pair-key).  Pre-fix the
    // batch was stored under B's NICK, which no query ever reads.
    b.client.clearRawBuffer();
    const messages = await waitForChathistory(b.client, a.nick, {
      minMessages: 1,
      timeoutMs: 8000,
    });
    const joined = messages.join('\n');
    expect(
      joined,
      'multiline DM content missing from CHATHISTORY: stored under recipient nick instead of the identity pair-key'
    ).toContain(lineId);
  });

  it('DM TAGMSG (reaction) is stored for event-playback and its msgid is anchorable (F4)', async () => {
    const a = await createAuthedDmClient('tgdma');
    track(a.client); if (a.fromPool) poolAccounts.push(a.account);
    const b = await createAuthedDmClient('tgdmb');
    track(b.client); if (b.fromPool) poolAccounts.push(b.account);

    // Seed a normal DM so the pair-key row exists and there is a msgid
    // to react to.
    const seedId = uniqueId();
    a.client.send(`PRIVMSG ${b.nick} :seed ${seedId}`);
    const seedMsg = await b.client.waitForParsedLine(
      m => m.command === 'PRIVMSG' && m.params[1]?.includes(seedId),
      5000
    );
    const seedMsgid = seedMsg.tags?.msgid;
    expect(seedMsgid, 'seed DM should carry a msgid tag').toBeTruthy();

    // B reacts to it via DM TAGMSG.
    const reactVal = 'thumbsup';
    b.client.send(`@+draft/react=${reactVal};+draft/reply=${seedMsgid} TAGMSG ${a.nick}`);
    await new Promise(r => setTimeout(r, 600));

    // A queries the DM buffer with TAGMSG in the accepted event types.
    // Pre-fix: DM TAGMSGs were never stored on any server.
    a.client.clearRawBuffer();
    const messages = await waitForChathistory(a.client, b.nick, {
      minMessages: 2,
      timeoutMs: 8000,
      eventTypes: ['PRIVMSG', 'TAGMSG'],
    });
    const joined = messages.join('\n');
    expect(joined, 'seed DM missing from pair-key history').toContain(seedId);
    expect(
      joined,
      'DM TAGMSG reaction missing from history: TAGMSG DMs were never stored (msgid black hole)'
    ).toContain(`draft/react=${reactVal}`);
  });
});
