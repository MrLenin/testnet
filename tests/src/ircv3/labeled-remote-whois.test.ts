import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
} from '../helpers/index.js';

/**
 * Field report (rdrake, 2026-09-01): a labeled remote WHOIS
 * ("WHOIS nick nick" for a user on another server) appeared to yield
 * only ACK — the remote's 311..318 "never arrived".
 *
 * Root cause: the forwarded-label batch wrapping the relayed numerics
 * was parked in DRAINING at the terminal numeric and only closed on
 * the CLIENT'S next command (even a PONG, ~90s later). A batch-spec
 * client buffers batched messages until close, so the whole reply sat
 * undelivered. Fix: close at the command's own terminal immediately;
 * a periodic sweep reaps the ambiguous/stranded cases.
 */

let asker: RawSocketClient;
let target: RawSocketClient;
let targetNick: string;

beforeAll(async () => {
  asker = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await asker.capLs();
  await asker.capReq(['labeled-response', 'batch', 'message-tags']);
  asker.capEnd();
  asker.register(uniqueNick('lwask'));
  await asker.waitForNumeric('001');

  target = await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
  await target.capLs();
  target.capEnd();
  targetNick = uniqueNick('lwtgt');
  target.register(targetNick);
  await target.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 500));
}, 30000);

afterAll(() => {
  asker?.close();
  target?.close();
});

describe('labeled remote WHOIS', () => {
  it('closes the forwarded-label batch at ENDOFWHOIS, without further client activity', async () => {
    asker.clearRawBuffer();
    asker.send(`@label=lw1 WHOIS ${targetNick} ${targetNick}`);

    // The batched reply and its CLOSE must both arrive promptly with
    // the client fully idle — no follow-up command may be needed.
    const opener = await asker.waitForLine(/label=lw1.*BATCH \+(\S+) labeled-response/, 8000);
    const batchId = opener.match(/BATCH \+(\S+) /)![1];

    await asker.waitForLine(new RegExp(`batch=${batchId}.* 311 `), 5000);
    await asker.waitForLine(new RegExp(`batch=${batchId}.* 318 `), 5000);
    const close = await asker.waitForLine(new RegExp(`BATCH -${batchId}`), 3000)
      .catch(() => null);
    expect(close,
      'BATCH close must follow the terminal numeric immediately, not the next client command')
      .toBeTruthy();
  }, 30000);

  it('second labeled query works too (no stranded FIFO slots)', async () => {
    asker.clearRawBuffer();
    asker.send(`@label=lw2 WHOIS ${targetNick} ${targetNick}`);
    const opener = await asker.waitForLine(/label=lw2.*BATCH \+(\S+) labeled-response/, 8000);
    const batchId = opener.match(/BATCH \+(\S+) /)![1];
    const close = await asker.waitForLine(new RegExp(`BATCH -${batchId}`), 3000)
      .catch(() => null);
    expect(close).toBeTruthy();
  }, 30000);
});
