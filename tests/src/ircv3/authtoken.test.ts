/**
 * draft/authtoken (IRCv3 PR #602) -- the token side of FILEHOST.
 *
 * A user asks the ircd for a short-lived, single-use token bound to one
 * pre-configured external service (TOKEN GENERATE); the service hands
 * the token back to the ircd over its own IRC connection (TOKEN
 * VALIDATE, usable before registration) and receives the claims the
 * network vouches for: account, name, member_of, operator_of, scope.
 * IRC passwords never reach the external service.
 *
 * Bed config (data/ircd.conf):
 *   Authtoken "FILEHOST"         -- type = "jwt", key = <P-256 scalar>, pass = "fh-validator-secret"
 *   Authtoken "evilnet/OPAQUE"   -- default type, pass = "fh-validator-secret" (PASSWDLEN is 20)
 *   Authtoken "evilnet/HOSTONLY" -- host = "172.29.0.0/16" (the docker net)
 *   Authtoken "evilnet/NOWHERE"  -- host = "10.255.255.0/24" (never matches)
 *
 * Fork decisions (docs/features/authtoken.md):
 *   - tokens replicate to every server (P10 TK) so the validator may
 *     connect anywhere; claims are evaluated live at VALIDATE time;
 *   - GENERATE needs an account (FAIL ACCOUNT_REQUIRED);
 *   - a validator's PASS is remembered across registration so a shim can
 *     keep one long-lived connection;
 *   - client-initiated draft/authtoken batches are NOT accepted (no
 *     `client-batch` cap token; random tokens fit one line);
 *   - a `type = "jwt"` service gets an ES256 JWT instead of a random
 *     string (the spec's self-validating variant): iss = network, aud =
 *     service url, sub = account, name, scope, iat, exp, jti; the service
 *     verifies it with the public key shown by STATS authtoken and tracks
 *     jti itself, no IRC connection needed.  TOKEN VALIDATE still works on
 *     the JWT (jti is the table key), so both paths coexist.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  createRawSocketClient, RawSocketClient, PRIMARY_SERVER, SECONDARY_SERVER,
  isSecondaryServerAvailable, IRC_OPER, uniqueNick, uniqueChannel,
  getTestAccount, releaseTestAccount, authenticateSaslPlain,
} from '../helpers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const FILEHOST_URL = 'https://paste.boxlabs.uk/filehost';
const VALIDATOR_PASS = 'fh-validator-secret';

function isupport(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    if (!/ 005 /.test(l)) continue;
    const body = l.replace(/^(@\S+ )?:\S+ 005 \S+ /, '').replace(/ :are supported.*$/, '');
    for (const t of body.split(' ')) {
      const [k, v] = t.split('=');
      if (k) out[k] = v ?? '';
    }
  }
  return out;
}

/** Claims from a draft/authtoken batch: repeated keys concatenate (spec). */
function claims(msgs: { command: string; params: string[] }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of msgs) {
    if (m.command !== 'TOKEN' || m.params[0] !== 'CLAIM') continue;
    out[m.params[1]] = (out[m.params[1]] ?? '') + (m.params[2] ?? '');
  }
  return out;
}

async function plainClient(nick: string, caps: string[] = []): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  if (caps.length) await c.capReq(caps);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

async function accountClient(account: string, password: string, nick: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['sasl', 'batch', 'draft/authtoken']);
  const r = await authenticateSaslPlain(c, account, password);
  if (!r.success) { c.close(); throw new Error(`SASL failed for ${account}: ${r.error}`); }
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  return c;
}

/** A validator connection: PASS first, optionally registered afterwards. */
async function validator(pass: string | null, opts: { register?: boolean; host?: string; port?: number } = {}): Promise<RawSocketClient> {
  const c = await createRawSocketClient(opts.host ?? PRIMARY_SERVER.host, opts.port ?? PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['batch']);
  if (pass) c.send(`PASS ${pass}`);
  if (opts.register) {
    c.capEnd();
    c.register(uniqueNick('shim'));
    await c.waitForNumeric('001');
  }
  return c;
}

async function generate(c: RawSocketClient, service: string, scope?: string): Promise<string> {
  c.send(`TOKEN GENERATE ${service}${scope ? ' ' + scope : ''}`);
  const m = await c.waitForParsedLine(x => (x.command === 'TOKEN' && x.params[0] === 'GENERATE') || x.command === 'FAIL', 5000);
  expect(m.command, m.raw).toBe('TOKEN');
  expect(m.params[1]).toBe(service);
  const token = m.params[2];
  expect(token, 'one-line token').toMatch(/^[A-Za-z0-9._-]{32,}$/);
  return token;
}

async function validate(c: RawSocketClient, service: string, token: string): Promise<{ ok: true; claims: Record<string, string> } | { ok: false; fail: string[] }> {
  c.clearCompletedBatches();
  c.send(`TOKEN VALIDATE ${service} :${token}`);
  const first = await c.waitForParsedLine(x => x.command === 'FAIL' || (x.command === 'BATCH' && x.params[0].startsWith('+') && x.params[1] === 'draft/authtoken'), 5000);
  if (first.command === 'FAIL') return { ok: false, fail: first.params };
  expect(first.params[2], 'batch parameter is the service key').toBe(service);
  const b = await c.waitForBatch('draft/authtoken', 5000);
  return { ok: true, claims: claims(b.messages) };
}

describe('draft/authtoken', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const track = (c: RawSocketClient) => { clients.push(c); return c; };
  let oper: RawSocketClient | null = null;
  afterEach(async () => {
    if (oper) { try { oper.send('RESET AUTHTOKEN_EXPIRE'); } catch { /* */ } await sleep(200); oper = null; }
    for (const c of clients) { try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });

  it('advertises the cap bare, lists services on the burst and on request, and publishes FILEHOST in ISUPPORT', async () => {
    const c = track(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
    const caps = await c.capLs();
    expect(caps.has('draft/authtoken'), 'cap present').toBe(true);
    expect(caps.get('draft/authtoken') ?? null, 'no client-batch token: batched VALIDATE not accepted').toBeNull();
    await c.capReq(['batch', 'draft/authtoken']);
    c.capEnd();
    c.register(uniqueNick('atb'));
    await c.waitForNumeric('001');
    await c.waitForNumeric(['376', '422']);
    const lines = c.allLines;
    const i005 = lines.findIndex(l => / 005 /.test(l));
    const iBatch = lines.findIndex(l => / BATCH \+\S+ draft\/authtoken \*$/.test(l));
    const iLusers = lines.findIndex(l => / 251 /.test(l));
    expect(iBatch, 'servicelist batch in the burst').toBeGreaterThan(i005);
    expect(iBatch, 'before LUSERS').toBeLessThan(iLusers);
    const burst = await c.waitForBatch('draft/authtoken', 2000);
    const keys = burst.messages.filter(m => m.command === 'TOKEN' && m.params[0] === 'SERVICE').map(m => m.params[1]);
    expect(keys).toContain('FILEHOST');
    expect(keys).toContain('evilnet/HOSTONLY');
    const fh = burst.messages.find(m => m.params[1] === 'FILEHOST')!;
    expect(fh.params[2]).toBe(FILEHOST_URL);
    expect(fh.params[3], 'description is the trailing parameter').toMatch(/\S/);

    const t = isupport(lines);
    expect(t['draft/FILEHOST'], 'draft/FILEHOST ISUPPORT').toBe(FILEHOST_URL);
    expect(t['soju.im/FILEHOST'], 'goguma compatibility alias').toBe(FILEHOST_URL);

    // On request, same batch shape.
    c.clearCompletedBatches();
    c.send('TOKEN SERVICELIST');
    const b = await c.waitForBatch('draft/authtoken', 5000);
    expect(b.params).toEqual(['*']);
    expect(b.messages.map(m => m.params[1])).toContain('FILEHOST');

    // Unknown subcommand.
    c.send('TOKEN BOGUS');
    const f = await c.waitForFail('TOKEN', 'UNKNOWN_COMMAND');
    expect(f.params[2]).toBe('BOGUS');

    // No burst without the cap.
    const d = track(await plainClient(uniqueNick('atn'), ['batch']));
    await d.waitForNumeric(['376', '422']);
    expect(d.allLines.some(l => / BATCH \+\S+ draft\/authtoken/.test(l)), 'no servicelist without the cap').toBe(false);
  });

  it('GENERATE needs an account, a known service and a scope the user can see', async () => {
    const anon = track(await plainClient(uniqueNick('ata')));
    anon.send('TOKEN GENERATE FILEHOST');
    const f1 = await anon.waitForFail('TOKEN', 'ACCOUNT_REQUIRED');
    expect(f1.raw).toContain('FILEHOST');

    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password, uniqueNick('atg')));
    u.send('TOKEN GENERATE example.com/NOPE');
    const f2 = await u.waitForFail('TOKEN', 'UNKNOWN_SERVICE');
    expect(f2.params[2]).toBe('example.com/NOPE');

    u.send('TOKEN GENERATE FILEHOST not-a-scope!');
    const f3 = await u.waitForFail('TOKEN', 'INVALID_SCOPE');
    expect(f3.params[2]).toBe('not-a-scope!');

    const elsewhere = uniqueChannel('atx');
    const other = track(await plainClient(uniqueNick('ato')));
    other.send(`JOIN ${elsewhere}`); await other.waitForJoin(elsewhere);
    u.send(`TOKEN GENERATE FILEHOST ${elsewhere}`);
    const f4 = await u.waitForFail('TOKEN', 'NO_PERMISSIONS');
    expect(f4.params[2], 'scope the user is not a member of').toBe(elsewhere);

    // Service keys are case-insensitive.
    const chan = uniqueChannel('atc');
    u.send(`JOIN ${chan}`); await u.waitForJoin(chan);
    await generate(u, 'filehost', chan);
  });

  it('VALIDATE before registration returns live claims, once, for the right service, to an authenticated validator', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const nick = uniqueNick('atv');
    const u = track(await accountClient(acc.account, acc.password, nick));
    const opChan = uniqueChannel('atop');
    const memChan = uniqueChannel('atmem');
    u.send(`JOIN ${opChan}`); await u.waitForJoin(opChan);           // creator is opped
    const owner = track(await plainClient(uniqueNick('atw')));
    owner.send(`JOIN ${memChan}`); await owner.waitForJoin(memChan);
    u.send(`JOIN ${memChan}`); await u.waitForJoin(memChan);         // plain member
    await sleep(300);

    const token = await generate(u, 'FILEHOST', opChan);

    // Wrong PASS: refused before the token is even looked at.
    const bad = track(await validator('wrong-secret'));
    const r0 = await validate(bad, 'FILEHOST', token);
    expect(r0.ok).toBe(false);
    if (!r0.ok) { expect(r0.fail[1]).toBe('NO_PERMISSIONS'); expect(r0.fail[2]).toBe('FILEHOST'); }

    // Host-gated service that never matches.
    const nowhere = track(await validator(null));
    const r1 = await validate(nowhere, 'evilnet/NOWHERE', token);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.fail[1]).toBe('NO_PERMISSIONS');

    // Host-gated service that matches, but the token is FILEHOST's.
    const r2 = await validate(nowhere, 'evilnet/HOSTONLY', token);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.fail[1]).toBe('INVALID_TOKEN');

    // The real thing: pre-registration, PASS-authenticated.
    const shim = track(await validator(VALIDATOR_PASS));
    const r3 = await validate(shim, 'FILEHOST', token);
    expect(r3.ok, JSON.stringify(r3)).toBe(true);
    if (r3.ok) {
      expect(r3.claims.account).toBe(acc.account);
      expect(r3.claims.name).toBe(nick);
      expect(r3.claims.scope).toBe(opChan);
      const member = r3.claims.member_of.split(' ');
      expect(member).toContain(opChan);
      expect(member).toContain(memChan);
      const op = r3.claims.operator_of.split(' ');
      expect(op).toContain(opChan);
      expect(op).not.toContain(memChan);
    }

    // Single use.
    const r4 = await validate(shim, 'FILEHOST', token);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.fail[1]).toBe('INVALID_TOKEN');

    // Garbage.
    const r5 = await validate(shim, 'FILEHOST', 'deadbeef'.repeat(8));
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.fail[1]).toBe('INVALID_TOKEN');

    // Claims are live: a token generated before a PART no longer lists the channel.
    const t2 = await generate(u, 'FILEHOST');
    u.send(`PART ${memChan}`); await u.waitForPart(memChan);
    await sleep(300);
    const r6 = await validate(shim, 'FILEHOST', t2);
    expect(r6.ok).toBe(true);
    if (r6.ok) {
      expect(r6.claims.member_of.split(' ')).not.toContain(memChan);
      expect(r6.claims.scope, 'no scope claim when none was requested').toBeUndefined();
    }
  });

  it('a registered validator keeps its PASS authority (long-lived shim connection)', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password, uniqueNick('atr')));
    const shim = track(await validator(VALIDATOR_PASS, { register: true }));
    const token = await generate(u, 'FILEHOST');
    const r = await validate(shim, 'FILEHOST', token);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.claims.account).toBe(acc.account);

    const noPass = track(await validator(null, { register: true }));
    const t2 = await generate(u, 'FILEHOST');
    const r2 = await validate(noPass, 'FILEHOST', t2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.fail[1]).toBe('NO_PERMISSIONS');
  });

  it('tokens expire (AUTHTOKEN_EXPIRE) and a client-initiated draft/authtoken batch is refused', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password, uniqueNick('ate')));
    oper = track(await plainClient(uniqueNick('atop')));
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    oper.send('SET AUTHTOKEN_EXPIRE 1');
    await sleep(300);
    const token = await generate(u, 'FILEHOST');
    await sleep(2500);
    const shim = track(await validator(VALIDATOR_PASS));
    const r = await validate(shim, 'FILEHOST', token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fail[1]).toBe('INVALID_TOKEN');

    u.send('BATCH +ab draft/authtoken FILEHOST');
    const f = await u.waitForFail('BATCH', 'UNKNOWN_TYPE');
    expect(f.params[2]).toBe('draft/authtoken');
  });

  it('a jwt service mints an ES256 token the service can verify with the published key', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const nick = uniqueNick('atj');
    const u = track(await accountClient(acc.account, acc.password, nick));
    const chan = uniqueChannel('atjw');
    u.send(`JOIN ${chan}`); await u.waitForJoin(chan);

    // The public key, as PEM, from STATS authtoken (the operator hands
    // this to the upload host).
    oper = track(await plainClient(uniqueNick('atjo')));
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    oper.send('STATS authtoken');
    await oper.waitForNumeric('219', 8000);
    const statLines = oper.allLines.filter(l => / 249 /.test(l)).map(l => l.replace(/^(@\S+ )?:\S+ 249 \S+ A :/, ''));
    const fhIdx = statLines.findIndex(l => /^FILEHOST\b/.test(l));
    expect(fhIdx, 'FILEHOST listed').toBeGreaterThanOrEqual(0);
    const pemLines: string[] = [];
    for (let i = fhIdx + 1; i < statLines.length; i++) {
      const l = statLines[i].trim();
      if (/^-----BEGIN PUBLIC KEY-----$/.test(l) || pemLines.length) pemLines.push(l);
      if (/^-----END PUBLIC KEY-----$/.test(l)) break;
    }
    expect(pemLines.length, 'PEM public key printed').toBeGreaterThan(2);
    const pubkey = createPublicKey(pemLines.join('\n') + '\n');
    expect(pubkey.asymmetricKeyType).toBe('ec');

    const token = await generate(u, 'FILEHOST', chan);
    const parts = token.split('.');
    expect(parts.length, 'compact JWT').toBe(3);
    const b64 = (x: string) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const header = JSON.parse(b64(parts[0]).toString());
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT' });
    const payload = JSON.parse(b64(parts[1]).toString());
    expect(payload.aud).toBe(FILEHOST_URL);
    expect(payload.sub).toBe(acc.account);
    expect(payload.name).toBe(nick);
    expect(payload.scope).toBe(chan);
    expect(typeof payload.iss).toBe('string');
    expect(payload.jti).toMatch(/^[0-9a-f]{48}$/);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(payload.iat - now)).toBeLessThan(120);
    expect(payload.exp - payload.iat).toBe(600);
    const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pubkey, dsaEncoding: 'ieee-p1363' }, b64(parts[2]));
    expect(ok, 'ES256 signature verifies with the published key').toBe(true);
    const tampered = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}x`), { key: pubkey, dsaEncoding: 'ieee-p1363' }, b64(parts[2]));
    expect(tampered).toBe(false);

    // A validator that does keep an IRC connection can still hand the JWT
    // to TOKEN VALIDATE: claims are live, and the jti is consumed.
    const shim = track(await validator(VALIDATOR_PASS));
    const r = await validate(shim, 'FILEHOST', token);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) { expect(r.claims.account).toBe(acc.account); expect(r.claims.operator_of.split(' ')).toContain(chan); }
    const r2 = await validate(shim, 'FILEHOST', token);
    expect(r2.ok).toBe(false);
    // A forged signature is refused even with a plausible shape.
    const t2 = await generate(u, 'FILEHOST');
    const p2 = t2.split('.');
    const forged = `${p2[0]}.${p2[1]}.${parts[2]}`;
    const r3 = await validate(shim, 'FILEHOST', forged);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.fail[1]).toBe('INVALID_TOKEN');

    // The opaque path is unchanged for services without a key.
    const op = await generate(u, 'evilnet/OPAQUE');
    expect(op).toMatch(/^[0-9a-f]{48}$/);
    const r4 = await validate(shim, 'evilnet/OPAQUE', op);
    expect(r4.ok).toBe(true);
  });

  it('a token generated on one server validates on another', async () => {
    if (!(await isSecondaryServerAvailable())) return;
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password, uniqueNick('atl')));
    const chan = uniqueChannel('atlk');
    u.send(`JOIN ${chan}`); await u.waitForJoin(chan);
    await sleep(500);
    const token = await generate(u, 'FILEHOST', chan);
    await sleep(500);
    const shim = track(await validator(VALIDATOR_PASS, { host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port }));
    const r = await validate(shim, 'FILEHOST', token);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.claims.account).toBe(acc.account);
      expect(r.claims.operator_of.split(' ')).toContain(chan);
    }
    // Consumed network-wide.
    const local = track(await validator(VALIDATOR_PASS));
    const r2 = await validate(local, 'FILEHOST', token);
    expect(r2.ok).toBe(false);
  });
});
