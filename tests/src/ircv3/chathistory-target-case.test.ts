import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueId,
  uniqueNick,
  waitForChathistory,
  X3Client,
  PRIMARY_SERVER,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * Channel, nick and account names are case-insensitive (rfc1459
 * casemapping), but the stores compare bytes.  Every key builder now
 * folds the names it embeds (nefarious db_casefold.h), so a lookup
 * matches whatever spelling the client typed, whether or not a live
 * object exists to supply the canonical one.  Field report 2026-09-02:
 * "#linux" found nothing for a channel created as "#Linux"; the
 * offline cases below were the audit's open items after that fix.
 */

async function mkAuthedClient(prefix: string, caps: string[]): Promise<{
  client: X3Client; account: string; fromPool: boolean; nick: string;
}> {
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(caps);
  c.capEnd();
  const nick = uniqueNick(prefix);
  c.register(nick);
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  c.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(c);
  return { client: c, account, fromPool, nick };
}

/** Take the client off the network for good: no bouncer hold, then QUIT. */
async function goOffline(c: X3Client): Promise<void> {
  await bouncerDisableHold(c);
  c.send('QUIT :offline');
  await new Promise(r => setTimeout(r, 800));
  try { c.close(); } catch { /* */ }
}

async function mkClient(prefix: string): Promise<X3Client> {
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags']);
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  c.clearRawBuffer();
  return c;
}

describe('chathistory target spelling is case-insensitive', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('LATEST finds a mixed-case channel queried in lower and upper case', async () => {
    const c = await mkClient('cfold');
    clients.push(c);

    // Canonical spelling is whatever the creator typed: mixed case.
    const channel = `#CaseFold-${uniqueId()}`;
    c.send(`JOIN ${channel}`);
    await c.waitForJoin(channel);

    const id = uniqueId();
    c.send(`PRIVMSG ${channel} :casefold ${id}`);
    await new Promise(r => setTimeout(r, 500));

    for (const spelling of [channel, channel.toLowerCase(), channel.toUpperCase()]) {
      c.clearRawBuffer();
      const messages = await waitForChathistory(c, spelling, {
        minMessages: 1,
        timeoutMs: 4000,
      });
      expect(
        messages.join('\n'),
        `LATEST ${spelling} did not return the message stored under ${channel}`
      ).toContain(id);
    }
  });

  it('BETWEEN with a lower-case spelling finds a mixed-case channel', async () => {
    const c = await mkClient('cfoldb');
    clients.push(c);

    const channel = `#CaseFold-${uniqueId()}`;
    c.send(`JOIN ${channel}`);
    await c.waitForJoin(channel);

    const tStart = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const id = uniqueId();
    c.send(`PRIVMSG ${channel} :casefold between ${id}`);
    await new Promise(r => setTimeout(r, 500));
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    c.clearRawBuffer();
    const messages = await waitForChathistory(c, channel.toLowerCase(), {
      minMessages: 1,
      timeoutMs: 4000,
      subcommand: 'BETWEEN',
      timestamp: tStart,
      timestamp2: tEnd,
    });
    expect(
      messages.join('\n'),
      `BETWEEN ${channel.toLowerCase()} returned nothing for a channel stored as ${channel}`
    ).toContain(id);
  });

  it('TARGETS lists a mixed-case channel under its live spelling', async () => {
    const { client: c, account, fromPool } = await mkAuthedClient('cfoldt',
      ['batch', 'server-time', 'draft/chathistory', 'message-tags']);
    clients.push(c);
    if (fromPool) poolAccounts.push(account);

    const channel = `#CaseFold-${uniqueId()}`;
    c.send(`JOIN ${channel}`);
    await c.waitForJoin(channel);

    const tStart = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    c.send(`PRIVMSG ${channel} :targets ${uniqueId()}`);
    await new Promise(r => setTimeout(r, 500));
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    c.clearRawBuffer();
    c.send(`CHATHISTORY TARGETS timestamp=${tStart} timestamp=${tEnd} 100`);
    const rows: string[] = [];
    while (true) {
      const m = await c.waitForParsedLine(
        l => (l.command === 'CHATHISTORY' && l.params[0] === 'TARGETS')
          || (l.command === 'BATCH' && l.params[0]?.startsWith('-')),
        5000);
      if (m.command === 'BATCH') break;
      rows.push(m.raw);
    }
    // The targets index keys the folded name; the listing shows the
    // channel as it is spelled on the network right now.
    expect(rows.join('\n'), 'TARGETS did not list the channel').toContain(channel);
  });
});

describe('PM history target spelling is case-insensitive when the other side is offline', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('LATEST by the counterparty ACCOUNT in the wrong case finds the conversation', async () => {
    // With the counterparty online the server resolves the typed name
    // through the user table; offline, the typed spelling used to be
    // copied straight into the pair key and scanned an empty prefix.
    const caps = ['batch', 'server-time', 'draft/chathistory', 'message-tags', 'sasl'];
    const a = await mkAuthedClient('cfpma', caps);
    clients.push(a.client);
    if (a.fromPool) poolAccounts.push(a.account);
    const b = await mkAuthedClient('cfpmb', caps);
    if (b.fromPool) poolAccounts.push(b.account);

    const id = uniqueId();
    a.client.send(`PRIVMSG ${b.nick} :pm casefold ${id}`);
    await new Promise(r => setTimeout(r, 600));

    await goOffline(b.client);

    const typed = b.account.toUpperCase();
    expect(typed).not.toBe(b.account);   /* the test needs a case difference */
    a.client.clearRawBuffer();
    const messages = await waitForChathistory(a.client, typed, {
      minMessages: 1,
      timeoutMs: 5000,
    });
    expect(
      messages.join('\n'),
      `LATEST ${typed} did not return the PM stored under the pair key for ${b.account}`
    ).toContain(id);
  });
});

describe('METADATA GET on an offline account is case-insensitive', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a key set while online reads back by the ACCOUNT in the wrong case after QUIT', async () => {
    const caps = ['draft/metadata-2', 'message-tags', 'sasl'];
    const setter = await mkAuthedClient('cfmda', caps);
    if (setter.fromPool) poolAccounts.push(setter.account);
    const reader = await mkAuthedClient('cfmdb', caps);
    clients.push(reader.client);
    if (reader.fromPool) poolAccounts.push(reader.account);

    const value = `casefold-${uniqueId()}`;
    setter.client.clearRawBuffer();
    setter.client.send(`METADATA * SET casefold-probe :${value}`);
    const set = await setter.client.waitForNumeric('761', 5000);
    expect(set.command).toBe('761');
    await new Promise(r => setTimeout(r, 300));

    await goOffline(setter.client);

    const typed = setter.account.toUpperCase();
    expect(typed).not.toBe(setter.account);
    reader.client.clearRawBuffer();
    reader.client.send(`METADATA ${typed} GET casefold-probe`);
    const got = await reader.client.waitForParsedLine(
      m => m.command === '761' || m.command === '766' || m.command === 'FAIL',
      5000);
    expect(got.raw, `METADATA ${typed} GET did not find the key set as ${setter.account}`)
      .toContain(value);
  });
});

describe('read-marker target spelling is case-insensitive', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a marker set as #CaseFold-x reads back as #casefold-x (account path)', async () => {
    const c = new X3Client();
    clients.push(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq(['draft/read-marker', 'server-time', 'message-tags']);
    c.capEnd();
    c.register(uniqueNick('cfmr'));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    c.clearRawBuffer();
    const { account, fromPool } = await setupTestAccount(c);
    if (fromPool) poolAccounts.push(account);

    const channel = `#CaseFold-${uniqueId()}`;
    c.send(`JOIN ${channel}`);
    await c.waitForJoin(channel);

    const ts = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    c.clearRawBuffer();
    c.send(`MARKREAD ${channel} timestamp=${ts}`);
    await c.waitForLine(/MARKREAD .*timestamp=/i, 5000);

    c.clearRawBuffer();
    c.send(`MARKREAD ${channel.toLowerCase()}`);
    const reply = await c.waitForLine(/MARKREAD /i, 5000);
    expect(
      reply,
      `marker set under ${channel} not found under ${channel.toLowerCase()}`
    ).toContain(`timestamp=${ts}`);
  });

  it('a session marker set as #Fold[x] reads back as #fold{x} (rfc1459 casemapping, ephemeral path)', async () => {
    // Unauthenticated: the marker lives in the in-memory session table,
    // whose hash used to fold only A-Z while the lookup compared with
    // ircd_strcmp (under which []\~ equal {}|^) -- a bucket miss.
    const c = new X3Client();
    clients.push(c);
    await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs();
    await c.capReq(['draft/read-marker', 'server-time', 'message-tags']);
    c.capEnd();
    c.register(uniqueNick('cfmrs'));
    await c.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    c.clearRawBuffer();

    const stem = uniqueId().slice(0, 8);
    const set = `#Fold[${stem}]`;
    const get = `#fold{${stem}}`;
    c.send(`JOIN ${set}`);
    await c.waitForJoin(set);

    const ts = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    c.clearRawBuffer();
    c.send(`MARKREAD ${set} timestamp=${ts}`);
    await c.waitForLine(/MARKREAD .*timestamp=/i, 5000);

    c.clearRawBuffer();
    c.send(`MARKREAD ${get}`);
    const reply = await c.waitForLine(/MARKREAD /i, 5000);
    expect(reply, `marker set under ${set} not found under ${get}`).toContain(`timestamp=${ts}`);
  });
});
