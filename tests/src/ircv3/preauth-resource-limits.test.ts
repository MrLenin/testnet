import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import {
  uniqueNick,
  uniqueId,
  X3Client,
  RawSocketClient,
  IRC_OPER,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  bouncerDisableHold,
  createRawSocketClient,
} from '../helpers/index.js';
import { WebSocketTestClient, buildFrame, WS_OPCODE } from '../helpers/websocket-client.js';

/* The WSS port: 8443 inside the compose network, 9998 as mapped on the host
 * (Chromium refuses 6697, so the bed maps 9998; 8443 is not mapped). */
const WS_PORT = parseInt(process.env.WS_PORT ?? (process.env.IRC_HOST === 'localhost' ? '9998' : '8443'));

/**
 * Cheap-to-send inputs that must not cost the server unbounded work
 * (the UnrealIRCd 6.2.7 class: unthrottled WebSocket pings, pre-auth
 * surfaces that never meet flood accounting).
 *
 *  - WebSocket control frames are answered inside the frame decoder,
 *    before anything reaches the recvQ, so an ordinary PING flood never
 *    met fakelag.  Now each control frame is charged like a command and a
 *    client that keeps going past the fakelag ceiling is dropped as
 *    Excess Flood.
 *  - STARTTLS (the deprecated IRCv3 `tls` cap) is off unless CAP_tls is
 *    explicitly enabled: the command answers 421 like any unknown one.
 *  - The webpush cooldown is keyed by the sender's session id, not its
 *    nick, so a nick change is not a fresh minute of pushes.
 *
 * The idle-connection event-loop spin (an accepted TLS/WS socket that
 * sends nothing kept epoll returning instantly) has no protocol-visible
 * effect; it is checked by hand with `docker stats` (see
 * docs/features/websocket.md).
 */

function pushKeys(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return `p256dh=${p256dh};auth=${auth}`;
}

async function operUp(): Promise<RawSocketClient> {
  const o = await createRawSocketClient();
  await o.capLs();
  o.capEnd();
  o.register(uniqueNick('prlop'));
  await o.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await o.waitForNumeric('381', 20000);
  return o;
}

async function pushesSent(o: RawSocketClient): Promise<number> {
  o.clearRawBuffer();
  o.send('STATS webpush');
  let sent = -1;
  for (;;) {
    // Generous: a pool account can carry stale endpoints from other runs, and
    // under valgrind each push costs ~2 s of server time before STATS answers.
    const m = await o.waitForParsedLine(x => x.command === '249' || x.command === '219', 20000);
    if (m.command === '219') break;
    const r = /Pushes since boot: (\d+) sent/.exec(m.params[m.params.length - 1]);
    if (r) sent = parseInt(r[1], 10);
  }
  expect(sent, 'STATS webpush has no push counters').toBeGreaterThanOrEqual(0);
  return sent;
}

describe('pre-auth resource limits', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends X3Client | RawSocketClient>(c: T): T => { clients.push(c); return c; };
  let oper: RawSocketClient | null = null;
  let endpointOwner: { c: X3Client; endpoint: string } | null = null;

  afterEach(async () => {
    if (endpointOwner) {
      try { endpointOwner.c.send(`WEBPUSH UNREGISTER ${endpointOwner.endpoint}`); } catch { /* */ }
      endpointOwner = null;
      await new Promise(r => setTimeout(r, 300));
    }
    if (oper) {
      try { oper.send('RESET WEBPUSH_IDLE'); oper.send('RESET WEBPUSH_COOLDOWN'); } catch { /* */ }
      await new Promise(r => setTimeout(r, 300));
      oper = null;
    }
    for (const c of clients) {
      try { await bouncerDisableHold(c as X3Client); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a WebSocket PING flood is dropped as Excess Flood instead of being answered forever', async () => {
    const ws = new WebSocketTestClient(undefined, WS_PORT);
    await ws.connect();
    try {
      // One PING is fine and gets its PONG.
      ws.sendFrame(Buffer.from('hi'), WS_OPCODE.PING);
      const pong = await ws.waitForPong(5000);
      expect(pong.payload.toString()).toBe('hi');

      // 2000 masked empty PINGs (12 KB) in one write: far past the
      // fakelag ceiling however generous the per-frame charge.
      const one = buildFrame(Buffer.alloc(0), WS_OPCODE.PING);
      ws.sendRaw(Buffer.concat(Array.from({ length: 2000 }, () => one)));
      await ws.waitForDisconnect(10000);
      expect(ws.isConnected()).toBe(false);
    } finally {
      ws.disconnect();
    }
  }, 30000);

  it('control frames have their own meter: pings before registration do not delay the registration burst', async () => {
    const ws = new WebSocketTestClient(undefined, WS_PORT);
    await ws.connect();
    try {
      // Eight PINGs before registering: well inside the control-frame
      // budget, but 16 s of debt if they were charged to fakelag, which
      // would stall the pipelined registration below for several seconds
      // (pre-registration is deliberately fakelag-free: OAUTHBEARER).
      for (let i = 0; i < 8; i++) ws.sendFrame(Buffer.from(`p${i}`), WS_OPCODE.PING);
      for (let i = 0; i < 8; i++) await ws.waitForPong(5000);

      const nick = uniqueNick('prlpre');
      const t0 = Date.now();
      ws.send('CAP LS 302');
      ws.send(`NICK ${nick}`);
      ws.send(`USER ${nick} 0 * :control-frame meter`);
      ws.send('CAP END');
      await ws.waitForText(/ 001 /, 4000);
      expect(Date.now() - t0, 'registration was delayed by the pings').toBeLessThan(4000);
    } finally {
      ws.disconnect();
    }
  }, 30000);

  it('empty data frames count on the same meter (they put nothing on the recvQ either)', async () => {
    // Reserved opcodes are not a case: the decoder already fails the
    // connection on the first one (RFC 6455 5.2).
    const ws = new WebSocketTestClient(undefined, WS_PORT);
    await ws.connect();
    try {
      const one = buildFrame(Buffer.alloc(0), WS_OPCODE.TEXT);
      ws.sendRaw(Buffer.concat(Array.from({ length: 2000 }, () => one)));
      const close = await ws.waitForClose(10000);
      expect(close.code).toBe(1008);
      await ws.waitForDisconnect(5000);
    } finally {
      ws.disconnect();
    }
  }, 30000);

  it('STARTTLS is an unknown command and `tls` is not offered unless CAP_tls is enabled', async () => {
    const c = track(await createRawSocketClient());
    const caps = await c.capLs();
    expect(caps.has('tls'), 'CAP LS offers tls while CAP_tls is off').toBe(false);
    c.clearRawBuffer();
    c.send('STARTTLS');
    const m = await c.waitForParsedLine(x => x.command === '421' || x.command === '670' || x.command === '691', 5000);
    expect(m.command, m.raw).toBe('421');
    c.capEnd();
  }, 15000);

  it('the push cooldown follows the sender across a nick change (keyed by session, not nick)', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);
    const p = await createBouncerClient(acc.account, acc.password, {
      nick: uniqueNick('prlcd'), extraCaps: ['draft/webpush'],
    });
    track(p.client);
    const nick = p.nick;

    const endpoint = `https://webhook.site/${uniqueId()}-cooldown`;
    p.client.clearRawBuffer();
    p.client.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await p.client.waitForParsedLine(
      m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointOwner = { c: p.client, endpoint };

    oper = await operUp();
    clients.push(oper);
    oper.send('SET WEBPUSH_COOLDOWN 60');
    // Away on the only connection: the account is unattended at once.
    p.client.send('AWAY :not looking');
    await new Promise(r => setTimeout(r, 500));

    const sender = track(await createRawSocketClient());
    await sender.capLs(); sender.capEnd();
    const s1 = uniqueNick('prlsn');
    sender.register(s1);
    await sender.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));

    const c0 = await pushesSent(oper);
    sender.send(`PRIVMSG ${nick} :first, should push`);
    await new Promise(r => setTimeout(r, 2500));
    const c1 = await pushesSent(oper);
    // Relative: a pool account may carry stale endpoints from other tests,
    // so one PM can be several pushes.
    expect(c1, 'the first PM from an unattended-account sender did not push').toBeGreaterThan(c0);

    const s2 = uniqueNick('prlsn');
    sender.send(`NICK ${s2}`);
    await sender.waitForParsedLine(m => m.command === 'NICK' && m.params[0] === s2, 5000);
    sender.send(`PRIVMSG ${nick} :second under a new nick, inside the cooldown`);
    await new Promise(r => setTimeout(r, 2500));
    const c2 = await pushesSent(oper);
    expect(c2, 'a nick change opened a fresh cooldown bucket').toBe(c1);

    // A different sender is a different origin and does push.
    const other = track(await createRawSocketClient());
    await other.capLs(); other.capEnd(); other.register(uniqueNick('prlot'));
    await other.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    other.send(`PRIVMSG ${nick} :someone else`);
    await new Promise(r => setTimeout(r, 2500));
    const c3 = await pushesSent(oper);
    expect(c3, 'a second sender must have its own cooldown').toBeGreaterThan(c2);
  }, 60000);
});
