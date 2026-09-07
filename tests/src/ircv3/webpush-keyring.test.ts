import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  uniqueId,
  uniqueNick,
  X3Client,
  IRCMessage,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
  setupTestAccount,
  releaseTestAccount,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * draft/webpush VAPID key ring (plan: .claude/para/projects/webpush-vapid-key-plan.md).
 *
 * The spec: "IRC servers SHOULD occasionally rotate their VAPID keys ...
 * (old keys must be kept at hand for existing subscriptions)".  The fork
 * keeps a ring of keys replicated over WP K, computes ONE current key by
 * a fixed rule on every server, advertises it in the VAPID ISUPPORT
 * token, and binds each registration to the key its client actually saw.
 *
 * Client-visible surfaces exercised here:
 *   - 005 VAPID=<key> on both linked servers: the same key (convergence).
 *   - STATS webpush (oper): ring contents, current key, per-key refs.
 *   - SET WEBPUSH_VAPID_PRIVKEY <b64url scalar> on ONE server: the network
 *     rotates to that key -- draft/extended-isupport clients on both
 *     servers get a fresh 005, STATS on both shows it current.
 *   - A client that saw the OLD key in its 005 and registers after the
 *     rotation is bound to the old key (STATS refs), which stays in the ring.
 *
 * Push delivery itself (signing with the bound key) is not observable
 * from the bed -- no capture endpoint -- see the plan's residue.
 */

/** P-256 key in the wire shapes: `d` = private scalar (what SET takes),
 * `pub` = uncompressed point base64url (what the VAPID token shows). */
function freshVapidKey(): { d: string; pub: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return { d: jwk.d, pub };
}

function vapidToken(msg: IRCMessage): string | null {
  if (msg.command !== '005') return null;
  const tok = msg.params.find(p => p.startsWith('VAPID='));
  return tok ? tok.slice('VAPID='.length) : null;
}

/** Connect, negotiate `caps`, register, and return the VAPID token from
 * the welcome 005 burst. */
async function connectSeeingKey(server: { host: string; port: number }, caps: string[], stem: string)
  : Promise<{ c: X3Client; key: string }> {
  const c = new X3Client();
  await c.connect(server.host, server.port);
  await c.capLs();
  if (caps.length) await c.capReq(caps);
  c.capEnd();
  c.register(uniqueNick(stem));
  await c.waitForNumeric('001');
  const line = await c.waitForParsedLine(m => vapidToken(m) !== null, 5000);
  await new Promise(r => setTimeout(r, 300));
  return { c, key: vapidToken(line)! };
}

async function operUp(c: X3Client) {
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForNumeric('381', 20000);
}

/** STATS webpush lines (RPL_STATSDEBUG 249 text), up to RPL_ENDOFSTATS. */
async function statsWebpush(c: X3Client): Promise<string[]> {
  c.clearRawBuffer();
  c.send('STATS webpush');
  const lines: string[] = [];
  for (;;) {
    const m = await c.waitForParsedLine(x => x.command === '249' || x.command === '219', 5000);
    if (m.command === '219') break;
    lines.push(m.params[m.params.length - 1]);
  }
  return lines;
}

function currentKeyOf(lines: string[]): string | null {
  const l = lines.find(x => x.includes('Current key: '));
  return l ? l.split('Current key: ')[1].trim() : null;
}

/** The "Key <16 chars>... gen N created T origin S refs R (current)" line
 * for a key, or null. */
function keyLine(lines: string[], key: string): string | null {
  return lines.find(x => x.includes(`Key ${key.slice(0, 16)}...`)) ?? null;
}

function refsOf(line: string): number {
  const m = /refs (\d+)/.exec(line);
  return m ? parseInt(m[1], 10) : -1;
}

function pushKeys(): string {
  const p256dh = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return `p256dh=${p256dh};auth=${auth}`;
}

describe('draft/webpush VAPID key ring', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];
  const endpointsToDrop: { c: X3Client; endpoint: string }[] = [];
  let resetConfigKey: X3Client | null = null;

  const track = (c: X3Client) => { clients.push(c); return c; };

  afterEach(async () => {
    for (const r of endpointsToDrop) {
      try { r.c.send(`WEBPUSH UNREGISTER ${r.endpoint}`); } catch { /* */ }
    }
    endpointsToDrop.length = 0;
    if (resetConfigKey) {
      // Clearing the config key demotes the manual key to automatic; it
      // stays current (highest generation) and rotates on the schedule.
      try { resetConfigKey.send('RESET WEBPUSH_VAPID_PRIVKEY'); } catch { /* */ }
      resetConfigKey = null;
    }
    await new Promise(r => setTimeout(r, 500));
    for (const c of clients) {
      try { await bouncerDisableHold(c); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('both linked servers advertise one current key and STATS webpush agrees', async () => {
    const a = await connectSeeingKey(PRIMARY_SERVER, [], 'wpk');
    track(a.c);
    const b = await connectSeeingKey(SECONDARY_SERVER, [], 'wpk');
    track(b.c);

    expect(a.key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(b.key, 'linked servers disagree on the current VAPID key').toBe(a.key);

    await operUp(a.c);
    const lines = await statsWebpush(a.c);
    expect(currentKeyOf(lines), `STATS webpush current key vs 005: ${lines.join(' / ')}`).toBe(a.key);
    const cur = keyLine(lines, a.key);
    expect(cur, 'current key missing from the ring listing').not.toBeNull();
    expect(cur).toContain('(current)');
    expect(lines.some(l => /Store: available, ring loaded/.test(l)), lines.join(' / ')).toBe(true);
  }, 40000);

  it('SET WEBPUSH_VAPID_PRIVKEY on one server rotates the network; a client that saw the old key binds to it', async () => {
    // Watchers with draft/extended-isupport on both servers: they receive
    // a fresh 005 when the current key changes.
    const w1 = await connectSeeingKey(PRIMARY_SERVER, ['draft/extended-isupport'], 'wpw');
    track(w1.c);
    const w2 = await connectSeeingKey(SECONDARY_SERVER, ['draft/extended-isupport'], 'wpw');
    track(w2.c);
    const oldKey = w1.key;
    expect(w2.key).toBe(oldKey);

    // The registrant sees the OLD key in its welcome burst and registers
    // only after the rotation.
    const reg = await connectSeeingKey(PRIMARY_SERVER, ['draft/webpush', 'sasl'], 'wpr');
    track(reg.c);
    expect(reg.key).toBe(oldKey);
    reg.c.clearRawBuffer();
    const { account, fromPool } = await setupTestAccount(reg.c);
    if (fromPool) poolAccounts.push(account);

    // Rotate from the primary via the config key.
    const oper = track(new X3Client());
    await oper.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await oper.capLs();
    oper.capEnd();
    oper.register(uniqueNick('wpop'));
    await oper.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    await operUp(oper);

    const fresh = freshVapidKey();
    w1.c.clearRawBuffer();
    w2.c.clearRawBuffer();
    resetConfigKey = oper;
    oper.send(`SET WEBPUSH_VAPID_PRIVKEY ${fresh.d}`);

    // The key derived from the scalar we set is what both servers now
    // advertise -- the secondary learned it over WP K.
    const n1 = await w1.c.waitForParsedLine(m => vapidToken(m) !== null, 10000);
    expect(vapidToken(n1)).toBe(fresh.pub);
    const n2 = await w2.c.waitForParsedLine(m => vapidToken(m) !== null, 15000);
    expect(vapidToken(n2), 'secondary did not converge on the new key').toBe(fresh.pub);

    // The registrant never saw the new key: its subscription binds to the
    // old one, which therefore stays in the ring (retired, referenced).
    const endpoint = `https://updates.push.services.mozilla.com/wpush/v2/${uniqueId()}`;
    reg.c.clearRawBuffer();
    reg.c.send(`WEBPUSH REGISTER ${endpoint} ${pushKeys()}`);
    const ack = await reg.c.waitForParsedLine(
      m => (m.command === 'WEBPUSH' && m.params[0] === 'REGISTER') || m.command === 'FAIL', 5000);
    expect(ack.command, ack.raw).toBe('WEBPUSH');
    endpointsToDrop.push({ c: reg.c, endpoint });

    const lines = await statsWebpush(oper);
    expect(currentKeyOf(lines)).toBe(fresh.pub);
    const newLine = keyLine(lines, fresh.pub);
    expect(newLine, lines.join(' / ')).not.toBeNull();
    expect(newLine).toContain('manual');
    expect(newLine).toContain('(current)');
    const oldLine = keyLine(lines, oldKey);
    expect(oldLine, `old key gone from the ring: ${lines.join(' / ')}`).not.toBeNull();
    expect(oldLine).not.toContain('(current)');
    expect(refsOf(oldLine!), `old key should be referenced by the new registration: ${oldLine}`)
      .toBeGreaterThanOrEqual(1);

    // The secondary holds both keys too (private halves included -- it
    // can sign for either), with the same current.
    const oper2 = track(new X3Client());
    await oper2.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    await oper2.capLs();
    oper2.capEnd();
    oper2.register(uniqueNick('wpo2'));
    await oper2.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    await operUp(oper2);
    const lines2 = await statsWebpush(oper2);
    expect(currentKeyOf(lines2)).toBe(fresh.pub);
    expect(keyLine(lines2, oldKey), `old key missing on the secondary: ${lines2.join(' / ')}`).not.toBeNull();
    expect(lines2.some(l => / NOT LOADED/.test(l)), `a key the secondary cannot sign with: ${lines2.join(' / ')}`).toBe(false);
  }, 90000);
});
