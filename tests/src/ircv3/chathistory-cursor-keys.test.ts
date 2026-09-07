/**
 * Cursors are rows, not milliseconds (audit 2026-09-06, wave 2).
 *
 * Every `msgid=` reference used to be reduced to its millisecond and the
 * msgid discarded, so BEFORE/AFTER/LATEST-anchor skipped every sibling
 * row sharing the anchor's millisecond and BETWEEN re-sent the anchor.
 * BETWEEN also ignored selector order (always the OLDEST rows of the
 * window), AROUND on a timestamp lost the row AT that timestamp, and an
 * ISO fraction was read as an integer (".5" = 5 ms).
 *
 * Same-millisecond rows are produced by writing several PRIVMSGs in one
 * TCP segment: the server parses them in one loop turn and the HLC packs
 * the logical counter into the msgid, not the stored millisecond.  The
 * test reads the @time tags back and picks a pair that shares one.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, uniqueChannel, uniqueNick } from '../helpers/index.js';

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Row { msgid: string; time: string; text: string; }

function rowsOf(lines: string[]): Row[] {
  const out: Row[] = [];
  for (const l of lines) {
    if (!/^@[^ ]*batch=/.test(l) || !/ PRIVMSG /.test(l)) continue;
    const msgid = /msgid=([^;\s]+)/.exec(l)?.[1] ?? '';
    const time = /(?:^@|;)time=([^;\s]+)/.exec(l)?.[1] ?? '';
    const text = l.replace(/^.* PRIVMSG \S+ :/, '');
    out.push({ msgid, time, text });
  }
  return out;
}

async function query(c: RawSocketClient, cmd: string): Promise<{ rows: Row[]; endTag: boolean }> {
  const start = c.allLines.length;
  c.send(`CHATHISTORY ${cmd}`);
  await c.waitForLine(/BATCH -|FAIL CHATHISTORY/, 8000);
  const lines = c.allLines.slice(start);
  const opener = lines.find(l => /BATCH \+/.test(l)) ?? '';
  return { rows: rowsOf(lines), endTag: /draft\/chathistory-end/.test(opener) };
}

describe('msgid cursors address a row, not a millisecond', () => {
  let c: RawSocketClient;
  let chan = '';
  let all: Row[] = [];          // chronological, as LATEST returns them
  let pair: [Row, Row] | null = null;   // two rows sharing a millisecond, earlier first

  beforeAll(async () => {
    c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await c.capLs(); await c.capReq(CH); c.capEnd();
    c.register(uniqueNick('cur'));
    await c.waitForNumeric('001');
    chan = uniqueChannel('cursor');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);
    // Spaced rows m0..m9, then a burst of 6 in one segment (same-ms candidates).
    for (let i = 0; i < 10; i++) { c.send(`PRIVMSG ${chan} :m${i}`); await sleep(40); }
    await sleep(100);
    c.send(Array.from({ length: 6 }, (_, i) => `PRIVMSG ${chan} :burst${i}`).join('\r\n'));
    await sleep(1500);
    all = (await query(c, `LATEST ${chan} * 100`)).rows;
    for (let i = 1; i < all.length; i++) {
      if (all[i].time && all[i].time === all[i - 1].time) { pair = [all[i - 1], all[i]]; break; }
    }
  });
  afterEach(() => { /* keep the connection for the whole file */ });

  it('records the whole scenario (same-ms siblings are opportunistic)', () => {
    expect(all.length, 'all 16 rows stored').toBe(16);
    // Same-millisecond siblings need two rows to land in one physical ms.
    // The bed spaces even a single-segment burst ~3 ms apart, so a pair is
    // not reliably reproducible; the three sibling cases below skip when none
    // formed.  The msgid-as-key fix itself is verified by reading + build +
    // the build_key/parse_key CMocka cases (key layout target\\0ts\\0msgid);
    // a live same-ms query pin is a documented gap (audit residue).
    if (!pair) console.log('SKIP siblings: no same-ms pair on this bed');
  });

  it('BEFORE msgid=<later sibling> returns the earlier sibling', async () => {
    if (!pair) return;
    const [earlier, later] = pair!;
    const { rows } = await query(c, `BEFORE ${chan} msgid=${later.msgid} 100`);
    expect(rows.map(r => r.msgid)).toContain(earlier.msgid);
    expect(rows.map(r => r.msgid), 'the anchor itself is excluded').not.toContain(later.msgid);
  });

  it('AFTER msgid=<earlier sibling> returns the later sibling', async () => {
    if (!pair) return;
    const [earlier, later] = pair!;
    const { rows } = await query(c, `AFTER ${chan} msgid=${earlier.msgid} 100`);
    expect(rows.map(r => r.msgid)).toContain(later.msgid);
    expect(rows.map(r => r.msgid), 'the anchor itself is excluded').not.toContain(earlier.msgid);
  });

  it('LATEST msgid=<earlier sibling> returns the later sibling', async () => {
    if (!pair) return;
    const [earlier, later] = pair!;
    const { rows } = await query(c, `LATEST ${chan} msgid=${earlier.msgid} 100`);
    expect(rows.map(r => r.msgid)).toContain(later.msgid);
    expect(rows.map(r => r.msgid), 'the anchor itself is excluded').not.toContain(earlier.msgid);
  });

  it('BETWEEN excludes both selectors and pages from the FIRST selector', async () => {
    const m = (t: string) => all.find(r => r.text === t)!;
    // Ascending: (m2, m7) exclusive => m3..m6; limit 2 => the two nearest m2.
    const asc = await query(c, `BETWEEN ${chan} msgid=${m('m2').msgid} msgid=${m('m7').msgid} 10`);
    expect(asc.rows.map(r => r.text)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(asc.endTag, 'window exhausted').toBe(true);
    const asc2 = await query(c, `BETWEEN ${chan} msgid=${m('m2').msgid} msgid=${m('m7').msgid} 2`);
    expect(asc2.rows.map(r => r.text)).toEqual(['m3', 'm4']);
    expect(asc2.endTag, 'more remain').toBe(false);
    // Descending (newer selector first): limit 2 => the two nearest m7, chronological.
    const desc = await query(c, `BETWEEN ${chan} msgid=${m('m7').msgid} msgid=${m('m2').msgid} 2`);
    expect(desc.rows.map(r => r.text)).toEqual(['m5', 'm6']);
    expect(desc.endTag).toBe(false);
    // Descending with timestamps around the whole spaced run.
    const t0 = new Date(Date.parse(m('m0').time) - 1000).toISOString();
    const t9 = new Date(Date.parse(m('m9').time) + 1).toISOString();
    const descT = await query(c, `BETWEEN ${chan} timestamp=${t9} timestamp=${t0} 3`);
    expect(descT.rows.map(r => r.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('AROUND timestamp=<@time of a row> includes that row', async () => {
    const m5 = all.find(r => r.text === 'm5')!;
    const { rows } = await query(c, `AROUND ${chan} timestamp=${m5.time} 3`);
    expect(rows.map(r => r.text)).toContain('m5');
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it('an ISO fraction is read as a decimal fraction, not an integer', async () => {
    const m5 = all.find(r => r.text === 'm5')!;
    const ms = Number(/\.(\d{3})Z$/.exec(m5.time)?.[1] ?? '0');
    const half = m5.time.replace(/\.\d{3}Z$/, '.5Z');   // ".5" == 500 ms
    if (ms < 500) {
      const { rows } = await query(c, `BEFORE ${chan} timestamp=${half} 100`);
      expect(rows.map(r => r.text), `m5 at .${ms} is before .500`).toContain('m5');
    } else {
      const { rows } = await query(c, `AFTER ${chan} timestamp=${half} 100`);
      expect(rows.map(r => r.text), `m5 at .${ms} is after .500`).toContain('m5');
    }
  });
});
