import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueId,
  uniqueNick,
  X3Client,
  PRIMARY_SERVER,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * PM history is keyed by an identity pair.  A party without an account
 * (an unauthenticated user, or a service bot such as AuthServ) is
 * identified by its per-connection session id, and CHATHISTORY TARGETS
 * used to hand that half of the key to the client as if it were a nick:
 * PoxChat opened "Dialog with AaBjiOiccaS+0hNCdrLt6w" on prod
 * (2026-09-02), the session id of AuthServ, whose login notices were
 * stored as PM history for every account.
 *
 * Now: service traffic is not stored at all; TARGETS names a PM row after
 * the other party (their live nick, else the nick their newest row
 * carries) and lists nothing it cannot name; the server's own
 * `+evilnet.github.io/sid=` marker never reaches a client.
 */

const SID_LIKE = /^[A-Za-z0-9+/_-]{22}$/;

async function collect(c: X3Client, cmd: string): Promise<string[]> {
  c.clearRawBuffer();
  c.send(cmd);
  const lines: string[] = [];
  while (true) {
    const m = await c.waitForParsedLine(
      l => l.command === 'BATCH' || l.command === 'PRIVMSG' || l.command === 'NOTICE'
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
    .map(l => l.match(/CHATHISTORY TARGETS (\S+) /))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => m[1]);
}

async function mkAuthed(prefix: string) {
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['batch', 'server-time', 'draft/chathistory', 'message-tags', 'sasl']);
  c.capEnd();
  const nick = uniqueNick(prefix);
  c.register(nick);
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  c.clearRawBuffer();
  const { account, fromPool } = await setupTestAccount(c);
  return { client: c, nick, account, fromPool };
}

async function mkEphemeral(prefix: string) {
  const c = new X3Client();
  await c.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['message-tags']);
  c.capEnd();
  const nick = uniqueNick(prefix);
  c.register(nick);
  await c.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  return { client: c, nick };
}

describe('PM targets are named after people, never after identities', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { await bouncerDisableHold(c); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('an unauthenticated correspondent who quit is listed by nick, and no session id marker is replayed', async () => {
    const a = await mkAuthed('tida');
    clients.push(a.client);
    if (a.fromPool) poolAccounts.push(a.account);
    const b = await mkEphemeral('tideph');

    const tStart = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const id = uniqueId();
    b.client.send(`PRIVMSG ${a.nick} :hello from ephemeral ${id}`);
    await new Promise(r => setTimeout(r, 500));
    a.client.send(`PRIVMSG ${b.nick} :reply ${id}`);
    await new Promise(r => setTimeout(r, 500));
    b.client.send('QUIT :gone');
    await new Promise(r => setTimeout(r, 800));
    try { b.client.close(); } catch { /* */ }
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    const targets = targetsOf(await collect(a.client,
      `CHATHISTORY TARGETS timestamp=${tStart} timestamp=${tEnd} 100`));
    expect(targets, `TARGETS must list the correspondent's nick: ${targets.join(' ')}`)
      .toContain(b.nick);
    for (const t of targets)
      expect(t, `a session id reached the client as a target: ${t}`).not.toMatch(SID_LIKE);

    const page = await collect(a.client, `CHATHISTORY LATEST ${b.nick} * 10`);
    expect(page.join('\n')).toContain(id);
    expect(page.join('\n'), 'the server-internal sid marker must be stripped').not.toContain('/sid=');
    const opener = page.find(l => /BATCH \+\S+ chathistory /.test(l)) ?? '';
    expect(opener).toContain(`chathistory ${b.nick}`);
  });

  it('service traffic is not stored and services never appear as PM targets', async () => {
    const a = await mkAuthed('tidsv');
    clients.push(a.client);
    if (a.fromPool) poolAccounts.push(a.account);

    // A logged-in user's command to AuthServ (such lines can carry a
    // password) and the bot's reply: neither is conversation history.
    const tStart = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
    a.client.send('PRIVMSG AuthServ :HELP');
    await new Promise(r => setTimeout(r, 1500));
    const tEnd = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    const page = await collect(a.client, 'CHATHISTORY LATEST AuthServ * 10');
    const rows = page.filter(l => / (PRIVMSG|NOTICE) /.test(l));
    expect(rows, `service traffic was stored as PM history:\n${rows.join('\n')}`).toHaveLength(0);

    const targets = targetsOf(await collect(a.client,
      `CHATHISTORY TARGETS timestamp=${tStart} timestamp=${tEnd} 100`));
    for (const t of targets) {
      expect(t.toLowerCase(), 'a service bot was listed as a PM target').not.toBe('authserv');
      expect(t, `a session id reached the client as a target: ${t}`).not.toMatch(SID_LIKE);
    }
  });
});
