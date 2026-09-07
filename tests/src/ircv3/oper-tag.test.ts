import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueNick,
  PRIMARY_SERVER,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * draft/oper-tag (#494): the server attaches a `draft/oper` tag to
 * every command sent by an operator, for recipients that negotiated
 * the cap. Fork policy: only DISPLAYED opers are tagged (hidden opers
 * are never disclosed), and the value (opername) is withheld unless
 * FEAT_OPERTAG_VALUE — so the default shape is the bare tag.
 */

let oper: RawSocketClient;
let seer: RawSocketClient;   // has draft/oper-tag
let blind: RawSocketClient;  // does not
const channel = uniqueChannel('opertag');

async function mkClient(caps: string[], prefix: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  if (caps.length) await c.capReq(caps);
  c.capEnd();
  c.register(uniqueNick(prefix));
  await c.waitForNumeric('001');
  return c;
}

beforeAll(async () => {
  oper = await mkClient([], 'otsrc');
  oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await oper.waitForNumeric('381', 5000);

  seer = await mkClient(['message-tags', 'draft/oper-tag'], 'otsee');
  blind = await mkClient(['message-tags'], 'otbld');

  for (const c of [oper, seer, blind]) {
    c.send(`JOIN ${channel}`);
    await c.waitForLine(new RegExp(`JOIN\\s+:?${channel}`, 'i'), 5000);
  }
  await new Promise(r => setTimeout(r, 300));
}, 30000);

afterAll(() => {
  for (const c of [oper, seer, blind]) c?.close();
});

describe('draft/oper-tag', () => {
  it('tags oper messages for cap-negotiated recipients (bare tag by default)', async () => {
    seer.clearRawBuffer();
    blind.clearRawBuffer();
    oper.send(`PRIVMSG ${channel} :oper says hi`);

    const line = await seer.waitForLine(/PRIVMSG.*oper says hi/, 5000);
    expect(line, 'recipient with the cap must see the draft/oper tag').toMatch(/draft\/oper[;\s=]/);
    // FEAT_OPERTAG_VALUE defaults off: bare tag, no opername disclosure
    expect(line).not.toMatch(/draft\/oper=/);

    const blindLine = await blind.waitForLine(/PRIVMSG.*oper says hi/, 5000);
    expect(blindLine, 'recipient without the cap must not see the tag').not.toMatch(/draft\/oper/);
  });

  it('does not tag non-oper senders', async () => {
    seer.clearRawBuffer();
    blind.send(`PRIVMSG ${channel} :civilian says hi`);
    const line = await seer.waitForLine(/PRIVMSG.*civilian says hi/, 5000);
    expect(line).not.toMatch(/draft\/oper/);
  });
});
