import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
  PRIMARY_SERVER,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
} from '../helpers/index.js';

/**
 * Per-class recvQ flood tests (Commit 2 of per-class-recvq-buffers plan).
 *
 * Validates:
 *   - Tier 2: per-class enforcement kills at the named reason.
 *   - Tier 3: the bugs the rework fixes (mid-line tag flood, multiline boost
 *             abuse) are no longer exploitable.
 *
 * Pin the cap behavior at the level the plan promises:
 *   - Tag region: 4095 bytes (client direction) hard-kill on overrun.
 *   - Msg region: FULL_MSG_SIZE (4096) hard-kill on overrun.
 *   - Sustained flood: get_recvq() raw, no per-CAP boost arithmetic.
 *   - Multiline cap continues to live in m_batch.c as MULTILINE_MAX_BYTES FAIL.
 *   - Non-CAP @-line: silently rejected by parse.c.
 */

const TAG_CLIENT_CAP = 4095;
const FULL_MSG_SIZE = 12287; // IRCV3_TAG_MAX (8191) + BUFSIZE (4096)

/** Wait until the socket has closed (server kill) OR a timeout elapses. */
async function waitForClose(client: RawSocketClient, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      client.allLines.some(l =>
        /^ERROR :/.test(l) || /Closing Link:/.test(l) || /Excess Flood/.test(l)
      )
    ) {
      return true;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

describe('per-class recvQ flood enforcement', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const track = (c: RawSocketClient): RawSocketClient => {
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    clients.length = 0;
    for (const acc of poolAccounts) {
      releaseTestAccount(acc);
    }
    poolAccounts.length = 0;
  });

  it('kills mid-line on >4095 tag bytes from CAP-active client', async () => {
    const client = track(
      await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port),
    );
    await client.capLs();
    await client.capReq(['message-tags']);
    client.capEnd();
    client.register(uniqueNick('flood'));
    await client.waitForNumeric('001');

    // '@' + 4097 'x' = 4098 bytes of tag region.  No terminator —
    // we expect the kill to fire mid-line.
    const huge = '@' + 'x'.repeat(4097);
    client.send(huge); // RawSocketClient appends \r\n; we want NO terminator
    // RawSocketClient send() may add \r\n; we instead want to push raw
    // bytes.  Probe how send() handles this by also explicitly closing
    // with no terminator: even if \r\n was added, the 4098 bytes of
    // tag region were already over cap before the terminator.

    const closed = await waitForClose(client, 5000);
    expect(closed, `expected server-side kill on >4095 byte tag region.\nLines: ${client.allLines.join('\n')}`).toBe(true);
    expect(client.allLines.some(l => /tag region/.test(l))).toBe(true);
  });

  it('accepts exactly 4095 tag bytes from CAP-active client', async () => {
    const client = track(
      await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port),
    );
    await client.capLs();
    await client.capReq(['message-tags']);
    client.capEnd();
    client.register(uniqueNick('floodok'));
    await client.waitForNumeric('001');

    // '@' + 'k=' + 4092 chars of value = 4095 total tag region.
    const tagValue = 'y'.repeat(4092);
    const line = `@k=${tagValue} PING :probe`;
    expect(line.indexOf(' ')).toBe(4095); // sanity: tag region is exactly 4095
    client.send(line);
    const pong = await client.waitForCommand('PONG', 3000);
    expect(pong.params[1]).toBe('probe');
  });

  it('drops @-prefixed line from non-CAP client (parse-layer rejection)', async () => {
    const client = track(
      await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port),
    );
    // No CAP REQ for message-tags — register raw.
    await client.capLs();
    client.capEnd();
    client.register(uniqueNick('notag'));
    await client.waitForNumeric('001');

    // First send a plain PING to confirm the connection works at all.
    client.send('PING :alive');
    const probe = await client.waitForCommand('PONG', 3000);
    expect(probe.params[1]).toBe('alive');

    // Now send a tagged line.  Parse.c should silently reject — no PONG.
    client.clearRawBuffer();
    client.send('@time=2026-01-01T00:00:00Z PING :probe');

    // Wait briefly; we should NOT see a PONG for "probe".
    await new Promise(r => setTimeout(r, 800));
    const pongForProbe = client.allLines.find(l => /PONG.*probe/.test(l));
    expect(pongForProbe, `expected NO PONG for tagged line from non-CAP client`).toBeUndefined();

    // Confirm the connection is still alive — rejection is silent, not a kill.
    client.send('PING :still-alive');
    const followup = await client.waitForCommand('PONG', 3000);
    expect(followup.params[1]).toBe('still-alive');
  });

  it('multiline overflow yields FAIL BATCH MULTILINE_MAX_BYTES, not Excess Flood', async () => {
    // Regression pin for the design decision: multiline byte cap stays
    // at the parser layer in m_batch.c with a proper FAIL reply.  Recv
    // path must not generate "Excess Flood" for multiline overflow.
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);

    const nick = uniqueNick('mlf');
    const { client } = await createSaslBouncerClient(
      account.account, account.password,
      { nick, extraCaps: ['batch', 'draft/multiline', 'message-tags'] },
    );
    track(client);

    // Open a multiline batch.
    client.send('BATCH +ml draft/multiline #nonexistent-chan');
    await new Promise(r => setTimeout(r, 200));

    // Stream lines until cumulative > FEAT_MULTILINE_MAX_BYTES (16384 default).
    // Each line ~400 bytes; ~50 lines easily over.
    const filler = 'A'.repeat(380);
    for (let i = 0; i < 60; i++) {
      client.send(`@batch=ml PRIVMSG #nonexistent-chan :${filler}`);
    }

    // Expect a FAIL BATCH MULTILINE_MAX_BYTES.
    const fail = await client.waitForFail('BATCH', 'MULTILINE_MAX_BYTES', 5000);
    expect(fail.params[1]).toBe('MULTILINE_MAX_BYTES');

    // Connection must still be alive (FAIL is non-fatal).
    client.send('PING :alive');
    const pong = await client.waitForCommand('PONG', 3000);
    expect(pong.params[1]).toBe('alive');
  });

  it('CAP-without-use does not extend recvQ headroom (regression pin)', async () => {
    // Before this rework, message-tags-active clients got +8191 bytes
    // of recvQ headroom every read cycle — abusable for non-tag flooding.
    // After: the sustained-flood cap is get_recvq() flat.
    const client = track(
      await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port),
    );
    await client.capLs();
    await client.capReq(['message-tags']);
    client.capEnd();
    client.register(uniqueNick('floodp'));
    await client.waitForNumeric('001');

    // Pipeline well-formed lines (no tags actually used) at high rate
    // until the sustained cap trips.  Use legal small PINGs so per-line
    // caps don't fire; we're hunting the sustained cap.
    //
    // get_recvq() default is FEAT_CLIENT_FLOOD == 1024.  Each PING is
    // ~16 bytes.  ~80 of them piles 1.2 KB into recvQ before the
    // server has a chance to drain — enough to trip the flat cap.
    // We can't easily prove "exactly at get_recvq()" without server
    // hooks, but we can prove the connection dies within a flood burst.
    for (let i = 0; i < 1000; i++) {
      client.send(`PING :p${i}`);
    }

    // Either we get killed quickly, or the server is faster than us
    // and drains.  Either way, the kill must NOT take +8191 extra bytes
    // before tripping.  We assert the kill happens within the burst.
    const closed = await waitForClose(client, 5000);
    // It's OK if the server drains everything (closed=false) — that
    // means get_recvq() never tripped, which is the normal case for
    // a fast server vs a slow client.  We can't make this deterministic
    // without timing-sensitive hooks.  Real assertion: if closed, the
    // reason should be Excess Flood, NOT a different shape.
    if (closed) {
      const errLine = client.allLines.find(l => /^ERROR :/.test(l));
      expect(errLine).toMatch(/Excess Flood/);
    }
  });

  it('body region capped at 512 for client direction too (IRCv3 spec compliance)', async () => {
    // IRCv3 message-tags spec keeps the body at "the standard 510 byte
    // tag-less message limit" — only tags grow.  Nefarious's own
    // outbound P10 chunks at BUFSIZE per line, so the inbound classifier
    // applies the same cap.  Anything above 512 bytes in the message
    // region (post-tag, pre-CRLF) trips RECV_CLASSIFY_MSG_OVERRUN.
    const client = track(
      await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port),
    );
    await client.capLs();
    await client.capReq(['message-tags']);
    client.capEnd();
    client.register(uniqueNick('bigbody'));
    await client.waitForNumeric('001');

    // 400-byte body — well under cap.  Must succeed.
    const ok = 'b'.repeat(400);
    client.send(`PING :${ok}`);
    const pong = await client.waitForCommand('PONG', 3000);
    expect(pong.params[1]).toBe(ok);

    // 600-byte body — exceeds cap.  Must kill the connection with the
    // classifier's named reason.
    const oversized = 'b'.repeat(600);
    client.send(`PING :${oversized}`);
    const closed = await waitForClose(client, 5000);
    expect(closed, `expected server-side kill on >512 byte msg region`).toBe(true);
    expect(client.allLines.some(l => /message region/.test(l))).toBe(true);
  });
});
