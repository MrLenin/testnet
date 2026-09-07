import { describe, it, expect, afterEach } from 'vitest';
import { uniqueNick, uniqueChannel, RawSocketClient, createRawSocketClient } from '../helpers/index.js';

/**
 * A reply is a message, not context (2026-09-05).
 *
 * The reply index (child rows carrying +reply=<parent>) feeds
 * draft/chathistory-context: rows spliced in after their parent, uncounted.
 * The spec scopes that to "reacts, redacts, edits" -- annotations of the
 * parent.  A PRIVMSG reply was indexed and spliced the same way, so a page
 * holding only the parent delivered the reply too, out of order and
 * tagged as context, and the next page delivered it again as itself.
 */

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tagsOf(l: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!l.startsWith('@')) return out;
  for (const kv of l.slice(1).split(' ')[0].split(';')) { const i = kv.indexOf('='); out[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '' : kv.slice(i + 1); }
  return out;
}

async function page(c: RawSocketClient, chan: string, cmd: string): Promise<{ msgid: string; cmd: string; ctx: boolean; reply?: string }[]> {
  const start = c.allLines.length;
  c.send(cmd);
  await sleep(1500);
  const lines = c.allLines.slice(start);
  const open = lines.find(l => / BATCH \+\S+ chathistory /.test(l));
  expect(open, `no batch for ${cmd}: ${lines.join('\n')}`).toBeTruthy();
  const id = / BATCH \+(\S+) /.exec(open!)![1];
  return lines.filter(l => l.includes(`batch=${id}`) && / (PRIVMSG|TAGMSG|NOTICE) /.test(l)).map(l => {
    const t = tagsOf(l);
    return { msgid: t.msgid, cmd: / (PRIVMSG|TAGMSG|NOTICE) /.exec(l)![1], ctx: 'draft/chathistory-context' in t, reply: t['+reply'] };
  });
}

describe('chathistory: replies are messages, reactions are context', () => {
  const clients: RawSocketClient[] = [];
  afterEach(() => { for (const c of clients) { try { c.send('QUIT'); c.close(); } catch { /* */ } } clients.length = 0; });

  it('a page holding only the parent gets its reactions as context, never the reply; the reply arrives once, in its own place', async () => {
    const chan = uniqueChannel('rpl');
    const c = await createRawSocketClient();
    clients.push(c);
    await c.capLs(); await c.capReq(CH); c.capEnd(); c.register(uniqueNick('rpl'));
    await c.waitForNumeric('001'); await sleep(300);
    c.send(`JOIN ${chan}`); await sleep(800);

    const say = async (text: string, tags = '') => {
      const start = c.allLines.length;
      c.send((tags ? `@${tags} ` : '') + `PRIVMSG ${chan} :${text}`);
      await sleep(600);
      const echo = c.allLines.slice(start).find(l => / PRIVMSG /.test(l) && l.endsWith(`:${text}`));
      expect(echo, `no echo for ${text}`).toBeTruthy();
      return tagsOf(echo!).msgid;
    };
    const A = await say('parent');
    const B = await say('reply to parent', `+reply=${A}`);
    const startC = c.allLines.length;
    c.send(`@+draft/react=👍;+reply=${A} TAGMSG ${chan}`); await sleep(600);
    const C = tagsOf(c.allLines.slice(startC).find(l => / TAGMSG /.test(l))!).msgid;
    const startC2 = c.allLines.length;
    c.send(`@+draft/react=🎉;+reply=${A} TAGMSG ${chan}`); await sleep(600);
    const C2 = tagsOf(c.allLines.slice(startC2).find(l => / TAGMSG /.test(l))!).msgid;
    const D = await say('later');
    await sleep(1000);

    // The parent alone: its two reactions follow it as context, in time order; the reply does not.
    const back = await page(c, chan, `CHATHISTORY BEFORE ${chan} msgid=${B} 1`);
    expect(back.map(r => `${r.msgid}${r.ctx ? '*' : ''}`)).toEqual([A, `${C}*`, `${C2}*`]);

    // The reply is a message: it comes in its own page, once, keeping its +reply tag, not as context.
    const fwd = await page(c, chan, `CHATHISTORY AFTER ${chan} msgid=${A} 1`);
    expect(fwd).toEqual([{ msgid: B, cmd: 'PRIVMSG', ctx: false, reply: A }]);

    // The whole conversation: every row once, ascending.
    const all = await page(c, chan, `CHATHISTORY LATEST ${chan} * 20`);
    const ids = all.map(r => r.msgid);
    expect(new Set(ids).size, `duplicate rows: ${ids.join(' ')}`).toBe(ids.length);
    expect(ids.filter(i => [A, B, C, C2, D].includes(i))).toEqual([A, B, C, C2, D]);
    expect(all.find(r => r.msgid === B)!.ctx).toBe(false);
  }, 60000);
});
