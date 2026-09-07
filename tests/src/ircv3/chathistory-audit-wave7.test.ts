/**
 * Re-review of the chathistory audit waves 0-3 (2026-09-07, wave 7).
 *
 * Client-observable pins for the wave-7 fixes.  The S2S-only items
 * (CH B/WB parc guard, write-forward budget, fed responder truncation)
 * and the presence part-coalesce (CMocka: chathistory_presence_cmocka
 * test_presence_part_coalesce_keeps_earlier_open) are not pinned here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, uniqueChannel, uniqueNick } from '../helpers/index.js';

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Row { msgid: string; text: string; }
function rowsOf(lines: string[]): Row[] {
  return lines
    .filter(l => /^@[^ ]*batch=/.test(l) && / PRIVMSG /.test(l))
    .map(l => ({ msgid: /msgid=([^;\s]+)/.exec(l)?.[1] ?? '', text: l.replace(/^.* PRIVMSG \S+ :/, '') }));
}
async function query(c: RawSocketClient, cmd: string): Promise<Row[]> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY ${cmd}`);
  await c.waitForLine(/BATCH -|FAIL CHATHISTORY/, 8000);
  return rowsOf(c.allLines.slice(start));
}
async function queryRaw(c: RawSocketClient, cmd: string): Promise<{ rows: Row[]; fail: string | null; opener: string }> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY ${cmd}`);
  await c.waitForLine(/BATCH -|FAIL CHATHISTORY/, 8000);
  const lines = c.allLines.slice(start);
  return {
    rows: rowsOf(lines),
    fail: lines.find(l => /FAIL CHATHISTORY/.test(l)) ?? null,
    opener: lines.find(l => /BATCH \+/.test(l)) ?? '',
  };
}

describe('wave 7: reverse-walk floor cannot be dodged by key length (R4)', () => {
  let c: RawSocketClient;
  afterEach(() => { try { c.send('QUIT'); c.close(); } catch { /* */ } });

  it('LATEST with an over-long msgid anchor still stops at the anchor row', async () => {
    c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs(); await c.capReq(CH); c.capEnd();
    c.register(uniqueNick('flr'));
    await c.waitForNumeric('001');
    const chan = uniqueChannel('floor');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    for (let i = 0; i < 8; i++) { c.send(`PRIVMSG ${chan} :f${i}`); await sleep(40); }
    await sleep(800);
    const all = await query(c, `LATEST ${chan} * 50`);
    expect(all.map(r => r.text)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']);
    const anchor = all.find(r => r.text === 'f4')!;

    // A msgid longer than every stored one decodes to the same millisecond
    // but builds a longer floor key.  The reverse walk compared
    // `klen >= floor_keylen` before memcmp, so every (shorter) row key
    // skipped the floor test and the page came back as a plain LATEST.
    const exact = await query(c, `LATEST ${chan} msgid=${anchor.msgid} 50`);
    expect(exact.map(r => r.text), 'exact anchor').toEqual(['f5', 'f6', 'f7']);
    const long = await query(c, `LATEST ${chan} msgid=${anchor.msgid}ZZZZZZZZ 50`);
    expect(long.map(r => r.text), 'over-long anchor is treated as the anchor, not ignored')
      .toEqual(['f5', 'f6', 'f7']);
  });
});

describe('wave 7: unknown msgid anchors (#73)', () => {
  let c: RawSocketClient;
  afterEach(() => { try { c.send('QUIT'); c.close(); } catch { /* */ } });

  it('BEFORE/AFTER/AROUND/BETWEEN fail with MESSAGE_ERROR naming the msgid; LATEST stays tolerant', async () => {
    c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs(); await c.capReq(CH); c.capEnd();
    c.register(uniqueNick('unk'));
    await c.waitForNumeric('001');
    const chan = uniqueChannel('unk');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    for (let i = 0; i < 3; i++) { c.send(`PRIVMSG ${chan} :u${i}`); await sleep(40); }
    await sleep(800);
    const all = await query(c, `LATEST ${chan} * 50`);
    expect(all.map(r => r.text)).toEqual(['u0', 'u1', 'u2']);

    // A legacy-shaped id: not in any store and not time-decodable.  An empty
    // page stamped chathistory-end told the client "nothing older" (#73).
    const legacy = 'AB-1234567-99';
    for (const sub of ['BEFORE', 'AFTER', 'AROUND']) {
      const r = await queryRaw(c, `${sub} ${chan} msgid=${legacy} 10`);
      expect(r.fail ?? '', `${sub}: FAIL`).toMatch(new RegExp(`FAIL CHATHISTORY MESSAGE_ERROR ${sub} ${chan.replace('#', '\\#')} ${legacy} :`));
      expect(r.opener, `${sub}: no batch`).toBe('');
    }
    const b = await queryRaw(c, `BETWEEN ${chan} msgid=${all[0].msgid} msgid=${legacy} 10`);
    expect(b.fail ?? '', 'BETWEEN second selector unknown').toMatch(/FAIL CHATHISTORY MESSAGE_ERROR BETWEEN /);
    // LATEST with an unknown anchor: the anchor only bounds, so the latest rows come back.
    const l = await queryRaw(c, `LATEST ${chan} msgid=${legacy} 10`);
    expect(l.fail, 'LATEST tolerant').toBeNull();
    expect(l.rows.map(r => r.text)).toEqual(['u0', 'u1', 'u2']);
  });
});

describe('wave 7: over-limit multiline lines are re-split, not cut (#26)', () => {
  let c: RawSocketClient;
  afterEach(() => { try { c.send('QUIT'); c.close(); } catch { /* */ } });

  it('a concat line longer than the wire comes back whole as concat parts split at spaces', async () => {
    c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs(); await c.capReq([...CH, 'draft/multiline']); c.capEnd();
    c.register(uniqueNick('cat'));
    await c.waitForNumeric('001');
    const chan = uniqueChannel('concat');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    // 1200 bytes of words in one logical line, sent as three concat parts.
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}`);   // "w000 " x200 = 1000 chars
    const text = words.join(' ');
    const parts = [text.slice(0, 400), text.slice(400, 800), text.slice(800)];
    c.send(`BATCH +cc1 draft/multiline ${chan}`);
    c.send(`@batch=cc1 PRIVMSG ${chan} :${parts[0]}`);
    c.send(`@batch=cc1;draft/multiline-concat PRIVMSG ${chan} :${parts[1]}`);
    c.send(`@batch=cc1;draft/multiline-concat PRIVMSG ${chan} :${parts[2]}`);
    c.send('BATCH -cc1');
    await sleep(1500);

    const start = c.allLines.length;
    c.send(`CHATHISTORY LATEST ${chan} * 10`);
    // The client's own "BATCH -cc1" echo is still unconsumed: wait for the
    // history batch close specifically.
    await c.waitForLine(/:\S+ BATCH -hist\d+\s*$/, 8000);
    const lines = c.allLines.slice(start);
    const inner = lines.filter(l => /^@batch=ml\d+/.test(l) && / PRIVMSG /.test(l));
    expect(inner.length, 'more than one wire part').toBeGreaterThan(1);
    // 512 bytes applies to the part after the tags (message-tags bounds the tag section separately).
    for (const l of inner) expect(l.replace(/^@\S+ /, '').length + 2, 'each part fits the wire').toBeLessThanOrEqual(512);
    const bodies = inner.map(l => l.replace(/^.* PRIVMSG \S+ :/, ''));
    expect(bodies.slice(1).every((_, i) => /draft\/multiline-concat/.test(inner[i + 1])), 'continuations carry concat').toBe(true);
    expect(/draft\/multiline-concat/.test(inner[0]), 'first part is not a continuation').toBe(false);
    expect(bodies.join(''), 'the whole line survives').toBe(text);
    // Split at spaces: no part ends mid-word (a part ends with a space or is the last).
    for (const b of bodies.slice(0, -1)) expect(b.endsWith(' '), `part ends at a word boundary: ...${b.slice(-8)}`).toBe(true);
  });
});
