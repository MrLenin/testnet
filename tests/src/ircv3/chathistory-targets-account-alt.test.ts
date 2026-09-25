/**
 * A private-message conversation is named after the nick the other party
 * used in it, not after whichever of their account's connections the
 * server finds first.
 *
 * PM history is keyed by identity (account), and an account can be online
 * under several nicks at once: a bouncer session on a fork server plus an
 * alt on a legacy server, which cannot join the session.  TARGETS and the
 * replay's batch target used to name the other party as "the live client
 * logged into that account, first match on the global list", on the
 * assumption that all of an account's connections share one nick.  With
 * the legacy alt connected last it won, so a conversation held entirely
 * with `Rubin` was listed as `Rub[1]n`, the client opened a tab under that
 * name, and the messages -- correctly sourced `Rubin` -- were filed there
 * (prod, 2026-09-24).
 *
 * Needs the bed's legacy comparison slot (nefarious-upstream, port 6671,
 * linked); the legacy alt authenticates through AuthServ, the only way in
 * on that server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import {
  uniqueId,
  uniqueNick,
  X3Client,
  PRIMARY_SERVER,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createRawSocketClient, RawSocketClient } from '../helpers/ircv3-client.js';

const LEGACY_PORT = 6671;

async function legacySlotUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(LEGACY_PORT, PRIMARY_SERVER.host);
    const done = (v: boolean) => { try { s.destroy(); } catch { /* */ } resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

async function collect(c: X3Client, cmd: string): Promise<string[]> {
  c.clearRawBuffer();
  c.send(cmd);
  const lines: string[] = [];
  while (true) {
    const m = await c.waitForParsedLine(
      (l) => l.command === 'BATCH' || l.command === 'PRIVMSG' || l.command === 'NOTICE'
        || l.command === 'CHATHISTORY' || l.command === 'FAIL',
      6000);
    lines.push(m.raw);
    if (m.command === 'FAIL') break;
    if (m.command === 'BATCH' && m.params[0]?.startsWith('-')) break;
  }
  return lines;
}

function targetsOf(lines: string[]): string[] {
  return lines
    .map((l) => l.match(/CHATHISTORY TARGETS (\S+) /))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]);
}

/** A client on the hub, logged in to a pool account (AuthServ AUTH). */
async function mkAuthed(prefix: string) {
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags', 'sasl']);
  c.capEnd();
  const nick = uniqueNick(prefix);
  c.register(nick);
  await c.waitForNumeric('001');
  await new Promise((r) => setTimeout(r, 300));
  c.clearRawBuffer();
  const { account, password, fromPool } = await setupTestAccount(c);
  return { client: c, nick, account, password, fromPool };
}

let up = false;
const clients: X3Client[] = [];
let legacy: RawSocketClient | null = null;
const poolAccounts: string[] = [];

beforeAll(async () => {
  up = await legacySlotUp();
});

afterAll(async () => {
  for (const c of clients) {
    try { await bouncerDisableHold(c); } catch { /* */ }
    try { c.send('QUIT'); } catch { /* */ }
    try { c.close(); } catch { /* */ }
  }
  try { legacy?.send('QUIT'); } catch { /* */ }
  try { legacy?.close(); } catch { /* */ }
  for (const a of poolAccounts) releaseTestAccount(a);
});

describe('a PM conversation is named after the nick it was held with', () => {
  it('when the other account is also online under another nick on a legacy server', async () => {
    expect(up, 'the legacy slot (nefarious-upstream, 6671) must be up and linked').toBe(true);

    // The other party: on the hub first ...
    const p = await mkAuthed('tgtp');
    clients.push(p.client);
    if (p.fromPool) poolAccounts.push(p.account);

    // ... and, connected AFTER it (newest on the global client list), the
    // same account's alt on the legacy server, under a different nick.
    legacy = await createRawSocketClient(PRIMARY_SERVER.host, LEGACY_PORT);
    await legacy.capLs();
    legacy.capEnd();
    const altNick = uniqueNick('tgtalt');
    legacy.register(altNick);
    await legacy.waitForNumeric('001', 25000);       // the legacy slot's lookups are slow
    legacy.clearRawBuffer();
    legacy.send(`PRIVMSG AuthServ :AUTH ${p.account} ${p.password}`);
    await legacy.waitForLine(/recogni[sz]e you|now identified|authenticated/i, 15000);
    await new Promise((r) => setTimeout(r, 1500));

    // The correspondent talks to the hub nick only.
    const u = await mkAuthed('tgtu');
    clients.push(u.client);
    if (u.fromPool) poolAccounts.push(u.account);

    const tStart = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const id = uniqueId();
    u.client.send(`PRIVMSG ${p.nick} :hello ${id}`);
    await new Promise((r) => setTimeout(r, 500));
    p.client.send(`PRIVMSG ${u.nick} :reply ${id}`);
    await new Promise((r) => setTimeout(r, 800));
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    const targets = targetsOf(await collect(u.client,
      `CHATHISTORY TARGETS timestamp=${tStart} timestamp=${tEnd} 100`));
    expect(targets, `TARGETS names the conversation after the nick it was held with: ${targets.join(' ')}`)
      .toContain(p.nick);
    expect(targets, `not after the account's other connection: ${targets.join(' ')}`)
      .not.toContain(altNick);

    const page = await collect(u.client, `CHATHISTORY LATEST ${p.nick} * 10`);
    expect(page.join('\n')).toContain(id);
    const opener = page.find((l) => /BATCH \+\S+ chathistory /.test(l)) ?? '';
    expect(opener, 'the batch names the nick that was asked for').toContain(`chathistory ${p.nick}`);
    for (const l of page)
      expect(l, 'the server-internal session ids must not reach a client').not.toMatch(/\/[sr]sid=/);

    // The other party renames: the same session under its new nick stands in
    // for the stored one; the legacy alt still does not.
    const renamed = uniqueNick('tgtq');
    p.client.clearRawBuffer();
    p.client.send(`NICK ${renamed}`);
    await p.client.waitForLine(new RegExp(`NICK :?${renamed}`), 10000);
    await new Promise((r) => setTimeout(r, 800));
    const after = targetsOf(await collect(u.client,
      `CHATHISTORY TARGETS timestamp=${tStart} timestamp=${tEnd} 100`));
    expect(after, `the same session, renamed: ${after.join(' ')}`).toContain(renamed);
    expect(after, `never the account's other connection: ${after.join(' ')}`).not.toContain(altNick);
    expect(after, `not the stale nick either: ${after.join(' ')}`).not.toContain(p.nick);
  }, 120_000);
});
