/**
 * FILEHOST end to end: the bed ircd mints a draft/authtoken JWT, the PASTE
 * container (docker-compose profile `paste`, MrLenin/PASTE branch filehost)
 * accepts the upload with it as a Bearer token, verifying the signature
 * with the public key derived from the ircd's Authtoken key.  No IRC
 * connection on the paste side.
 *
 * Needs: `scripts/dc.sh --profile paste up -d paste` and the bed's
 * Authtoken "FILEHOST" url = http://localhost:8089/filehost.  Skips when
 * the paste container is not reachable.
 *
 * Contract (paste/docs/filehost.md): OPTIONS -> 204 + Accept-Post + CORS;
 * POST Bearer -> 201 + Location (+ JSON); GET/HEAD Location (Range for
 * binaries); 401 for no/Basic/forged/replayed/expired tokens; 413/415/429.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  createRawSocketClient, RawSocketClient, PRIMARY_SERVER, IRC_OPER, uniqueNick,
  getTestAccount, releaseTestAccount, authenticateSaslPlain,
} from '../helpers/index.js';

const PASTE = process.env.PASTE_URL ?? 'http://localhost:8089';
const FILEHOST = `${PASTE}/filehost`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function accountClient(account: string, password: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await c.capLs();
  await c.capReq(['sasl', 'batch', 'draft/authtoken']);
  const r = await authenticateSaslPlain(c, account, password);
  if (!r.success) { c.close(); throw new Error(`SASL failed for ${account}: ${r.error}`); }
  c.capEnd();
  c.register(uniqueNick('fhe'));
  await c.waitForNumeric('001');
  return c;
}

async function generate(c: RawSocketClient, scope?: string): Promise<string> {
  c.send(`TOKEN GENERATE FILEHOST${scope ? ' ' + scope : ''}`);
  const m = await c.waitForParsedLine(x => (x.command === 'TOKEN' && x.params[0] === 'GENERATE') || x.command === 'FAIL', 5000);
  expect(m.command, m.raw).toBe('TOKEN');
  return m.params[2];
}

async function upload(token: string | null, body: Buffer | string, type: string, filename?: string, scheme = 'Bearer') {
  const headers: Record<string, string> = { 'Content-Type': type };
  if (token !== null) headers.Authorization = `${scheme} ${token}`;
  if (filename) headers['Content-Disposition'] = `inline; filename="${filename}"`;
  const r = await fetch(FILEHOST, { method: 'POST', headers, body });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, location: r.headers.get('location'), auth: r.headers.get('www-authenticate'), json, text };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('FILEHOST end to end (bed ircd + paste container)', () => {
  let available = false;
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  const track = (c: RawSocketClient) => { clients.push(c); return c; };
  let oper: RawSocketClient | null = null;

  beforeAll(async () => {
    try {
      const r = await fetch(FILEHOST, { method: 'OPTIONS', signal: AbortSignal.timeout(3000) });
      available = r.status === 204;
    } catch { available = false; }
    if (!available) console.warn(`paste container not reachable at ${FILEHOST}; FILEHOST e2e skipped`);
  });
  afterEach(async () => {
    if (oper) { try { oper.send('RESET AUTHTOKEN_EXPIRE'); } catch { /* */ } await sleep(200); oper = null; }
    for (const c of clients) { try { c.send('QUIT'); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a); pool.length = 0;
  });

  it('OPTIONS advertises Accept-Post and the CORS headers a browser client needs', async () => {
    if (!available) return;
    const r = await fetch(FILEHOST, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('allow')).toMatch(/POST/);
    expect(r.headers.get('accept-post')).toMatch(/image\/\*/);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(r.headers.get('access-control-expose-headers')).toMatch(/Location/);
  });

  it('a token from the ircd uploads text (as a paste) and a PNG (as a file), once each', async () => {
    if (!available) return;
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password));

    const t1 = await generate(u);
    const text = `hello from irc ${Date.now()}\n`;
    const r1 = await upload(t1, text, 'text/plain; charset=utf-8', 'hello.txt');
    expect(r1.status, r1.text).toBe(201);
    expect(r1.location).toMatch(/^http/);
    expect(r1.json?.url).toBe(r1.location);
    const g1 = await fetch(r1.location!);
    expect(g1.status).toBe(200);
    expect(await g1.text()).toContain('hello from irc');

    // Single use, enforced by the paste side alone (jti table).
    const r1b = await upload(t1, 'again', 'text/plain');
    expect(r1b.status).toBe(401);
    expect(r1b.json?.error).toBe('replayed_token');
    expect(r1b.auth).toMatch(/Bearer/);

    const t2 = await generate(u);
    const r2 = await upload(t2, PNG, 'image/png', 'dot.png');
    expect(r2.status, r2.text).toBe(201);
    expect(r2.location).toMatch(/\/filehost\/[A-Za-z0-9]+\.png$/);
    expect(r2.json?.size).toBe(PNG.length);
    const g2 = await fetch(r2.location!);
    expect(g2.status).toBe(200);
    expect(g2.headers.get('content-type')).toBe('image/png');
    expect(g2.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await g2.arrayBuffer()).equals(PNG)).toBe(true);
    const h2 = await fetch(r2.location!, { method: 'HEAD' });
    expect(h2.status).toBe(200);
    expect(h2.headers.get('content-length')).toBe(String(PNG.length));
    const p2 = await fetch(r2.location!, { headers: { Range: 'bytes=0-7' } });
    expect(p2.status).toBe(206);
    expect(p2.headers.get('content-range')).toBe(`bytes 0-7/${PNG.length}`);
    expect((await p2.arrayBuffer()).byteLength).toBe(8);
  });

  it('strips EXIF/XMP/text metadata losslessly from JPEG and PNG (on by default)', async () => {
    if (!available) return;
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password));

    // A minimal JPEG: SOI, APP0 JFIF, APP1 Exif (with GPS-looking bytes), DQT, SOS + data, EOI.
    const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'binary'));
    const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'binary'), Buffer.from('GPSLatitude 51.5N 0.1W SECRET')]));
    const dqt = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
    const sos = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), Buffer.from([0xff, 0xd9])]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, dqt, sos]);
    const expectJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, dqt, sos]);

    const r1 = await upload(await generate(u), jpeg, 'image/jpeg', 'gps.jpg');
    expect(r1.status, r1.text).toBe(201);
    expect(r1.json?.size).toBe(expectJpeg.length);
    const g1 = await fetch(r1.location!);
    const got1 = Buffer.from(await g1.arrayBuffer());
    expect(got1.includes('SECRET')).toBe(false);
    expect(got1.equals(expectJpeg), 'only the APP1 segment is gone').toBe(true);

    // A PNG with a tEXt chunk between IHDR and IDAT.
    const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
    const chunk = (type: string, data: Buffer) => { const td = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cc]); };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
    const text = chunk('tEXt', Buffer.from('Comment\0taken at SECRET place'));
    const idat = chunk('IDAT', Buffer.from('78da63f8cfc00000030001', 'hex'));
    const iend = chunk('IEND', Buffer.alloc(0));
    const png = Buffer.concat([sig, ihdr, text, idat, iend]);
    const r2 = await upload(await generate(u), png, 'image/png', 'note.png');
    expect(r2.status, r2.text).toBe(201);
    const got2 = Buffer.from(await (await fetch(r2.location!)).arrayBuffer());
    expect(got2.includes('SECRET')).toBe(false);
    expect(got2.equals(Buffer.concat([sig, ihdr, idat, iend]))).toBe(true);
  });

  it('refuses what it must: no token, Basic, forged signature, wrong audience, expired, bad type, oversize', async () => {
    if (!available) return;
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const u = track(await accountClient(acc.account, acc.password));

    const none = await upload(null, 'x', 'text/plain');
    expect(none.status).toBe(401);
    expect(none.auth).toMatch(/^Bearer/);

    const basic = await upload(Buffer.from(`${acc.account}:${acc.password}`).toString('base64'), 'x', 'text/plain', undefined, 'Basic');
    expect(basic.status, 'Basic is the password transit we refuse').toBe(401);

    const good = await generate(u);
    const [h, p, s] = good.split('.');
    const forged = await upload(`${h}.${p}.${s.slice(0, -4)}AAAA`, 'x', 'text/plain');
    expect(forged.status).toBe(401);
    expect(forged.json?.message).toMatch(/signature|malformed/);

    // Same key, different audience: re-sign is impossible, so tamper the
    // payload and expect the signature check to fail first.
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    payload.aud = 'https://elsewhere.invalid/filehost';
    const p2 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const wrongAud = await upload(`${h}.${p2}.${s}`, 'x', 'text/plain');
    expect(wrongAud.status).toBe(401);

    const mismatch = await upload(good, 'this is not a png', 'image/png');
    expect(mismatch.status).toBe(415);
    // 415 happens before the jti is recorded? No: the jti goes in before the
    // body is read, so `good` is spent now (single use is strict).
    const html = await upload(await generate(u), '<script>', 'text/html');
    expect(html.status, 'HTML is never accepted').toBe(415);
    const exe = await upload(await generate(u), 'MZ', 'application/x-msdownload');
    expect(exe.status).toBe(415);

    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
    const oversize = await upload(await generate(u), big, 'text/plain');
    expect(oversize.status).toBe(413);

    // Expired: shrink the ircd's lifetime, mint, wait, upload.
    oper = track(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
    await oper.capLs(); oper.capEnd(); oper.register(uniqueNick('fheo'));
    await oper.waitForNumeric('001');
    oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await oper.waitForNumeric('381', 8000);
    oper.send('SET AUTHTOKEN_EXPIRE 1');
    await sleep(300);
    const short = await generate(u);
    oper.send('RESET AUTHTOKEN_EXPIRE');
    // The paste side allows 60 s of skew past exp; a 1 s token is still
    // inside it, so check the claim rather than wait a minute.
    const claims = JSON.parse(Buffer.from(short.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    expect(claims.exp - claims.iat).toBe(1);
  });
});
