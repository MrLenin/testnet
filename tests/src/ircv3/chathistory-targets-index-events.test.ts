import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick, RawSocketClient, getTestAccount, releaseTestAccount,
  createSaslBouncerClient, createRawSocketClient,
} from '../helpers/index.js';

/**
 * Which events move a target's CHATHISTORY TARGETS stamp (user decision
 * 2026-10-20, from Seance PR #121's server notes): a REDACT and a TOPIC
 * change do, a KICK does not.  A client that orders its catch-up with
 * TARGETS and skips channels whose stamp it already holds would otherwise
 * keep a deleted message on screen, or miss a topic change, in a channel
 * that was quiet since.  KICK stays out: join/part/kick churn floated
 * channels to the top and listed event-only channels as conversations
 * (audit 2026-09-06 #23/#28).
 */
const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags',
            'echo-message', 'draft/message-redaction'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('CHATHISTORY TARGETS stamp moves on REDACT and TOPIC, not on KICK', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  async function targets(c: RawSocketClient): Promise<Map<string, string>> {
    const from = new Date(Date.now() - 300_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const start = c.allLines.length;
    c.send(`CHATHISTORY TARGETS timestamp=${from} timestamp=${to} 50`);
    await sleep(2000);
    const rows = new Map<string, string>();
    for (const l of c.allLines.slice(start)) {
      const m = / CHATHISTORY TARGETS (\S+) (?:timestamp=)?(\S+)/.exec(l);
      if (m) rows.set(m[1].toLowerCase(), m[2]);
    }
    return rows;
  }

  async function msgid(c: RawSocketClient, channel: string, text: string): Promise<string> {
    c.send(`PRIVMSG ${channel} :${text}`);
    const echo = await c.waitForParsedLine(
      m => m.command === 'PRIVMSG' && m.raw.includes(text) && !/(^|;)batch=/.test(m.raw), 5000);
    const m = /msgid=([^\s;]+)/.exec(echo.raw);
    if (!m) throw new Error(`no msgid in echo: ${echo.raw}`);
    return m[1];
  }

  it('REDACT and TOPIC move the stamp; KICK leaves it', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const me = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('tix'), extraCaps: CH });
    clients.push(me.client);
    const a = `#tix-a-${tag}`, b = `#tix-b-${tag}`;
    me.client.send(`JOIN ${a}`); await sleep(300);
    me.client.send(`JOIN ${b}`); await sleep(300);

    // A victim for the KICK case, in both channels.
    const victim = await createRawSocketClient(); clients.push(victim);
    const vnick = uniqueNick('tixv');
    await victim.capLs(); victim.capEnd(); victim.register(vnick);
    await victim.waitForNumeric('001'); await sleep(200);
    victim.send(`JOIN ${a}`); await sleep(300);

    // Baseline: A then B, so B's stamp is the newer one.
    const idA = await msgid(me.client, a, `in a ${tag}`); await sleep(1200);
    await msgid(me.client, b, `in b ${tag}`); await sleep(1200);
    let t = await targets(me.client);
    expect(t.get(a), `baseline rows: ${[...t]} raw: ${me.client.allLines.filter(l => /TARGETS|BATCH/.test(l)).slice(-6).join(' | ')}`).toBeDefined();
    expect(t.get(b)! > t.get(a)!, `baseline: b newer than a (${t.get(a)} vs ${t.get(b)})`).toBe(true);

    // REDACT in A moves A past B.
    me.client.send(`REDACT ${a} ${idA}`); await sleep(1500);
    t = await targets(me.client);
    expect(t.get(a)! > t.get(b)!, `after REDACT in a: a newer than b (${t.get(a)} vs ${t.get(b)})`).toBe(true);

    // TOPIC in B moves B past A.
    me.client.send(`TOPIC ${b} :topic ${tag}`); await sleep(1500);
    t = await targets(me.client);
    expect(t.get(b)! > t.get(a)!, `after TOPIC in b: b newer than a (${t.get(a)} vs ${t.get(b)})`).toBe(true);

    // KICK in A does not move A.
    const beforeKick = t.get(a)!;
    me.client.send(`KICK ${a} ${vnick}`); await sleep(1500);
    t = await targets(me.client);
    expect(t.get(a), 'after KICK in a: stamp unchanged').toBe(beforeKick);
  }, 60000);
});
