import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
} from '../helpers/index.js';

/**
 * Multiline cooldown — the per-batch close-time charge has been redesigned:
 * cli_since no longer accumulates per-line lag during the batch (which
 * froze the entire connection); instead, a multiline-only cooldown is
 * applied via con_ml_cooldown_until, with a small flat cli_since charge.
 *
 * Memory: project_multiline_cooldown_redesign
 *
 * Coverage:
 *  - Cooldown is multiline-only (regular commands still work mid-cooldown).
 *  - FAIL BATCH MULTILINE_COOLDOWN <seconds> when a second batch is opened
 *    during cooldown.
 *  - Byte-cost gradient: larger batch → larger cooldown.
 *  - cli_since only takes the small flat charge (user can immediately PING
 *    after batch close).
 */
describe('IRCv3 Multiline Cooldown', () => {
  const clients: RawSocketClient[] = [];

  const track = (c: RawSocketClient): RawSocketClient => {
    clients.push(c);
    return c;
  };

  afterEach(() => {
    for (const c of clients) {
      try { c.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
  });

  /** Open a multiline DM batch, send N lines of `bytesPerLine` 'x's, close. */
  async function sendBatch(
    client: RawSocketClient,
    targetNick: string,
    lines: number,
    bytesPerLine: number,
  ): Promise<void> {
    const batchId = `ml${Date.now().toString(36)}`;
    const filler = 'x'.repeat(bytesPerLine);

    client.send(`BATCH +${batchId} draft/multiline ${targetNick}`);
    for (let i = 0; i < lines; i++) {
      client.send(`@batch=${batchId} PRIVMSG ${targetNick} :${filler}`);
    }
    client.send(`BATCH -${batchId}`);

    // Give the server a moment to process the close + cooldown set.
    await new Promise(r => setTimeout(r, 200));
  }

  async function setupSender(): Promise<{
    sender: RawSocketClient;
    recipient: RawSocketClient;
    recipientNick: string;
  }> {
    const senderClient = track(await createRawSocketClient());
    await senderClient.capLs();
    await senderClient.capReq(['draft/multiline', 'message-tags', 'batch']);
    senderClient.capEnd();
    senderClient.register(uniqueNick('mlcs'));
    await senderClient.waitForNumeric('001');

    const recipientClient = track(await createRawSocketClient());
    const recipientNick = uniqueNick('mlcr');
    recipientClient.register(recipientNick);
    await recipientClient.waitForNumeric('001');

    return { sender: senderClient, recipient: recipientClient, recipientNick };
  }

  it('emits FAIL BATCH MULTILINE_COOLDOWN with a remaining-seconds context on early second batch', async () => {
    const { sender, recipientNick } = await setupSender();

    // 4 KB batch: 16 lines × 256 bytes.  Total ≈ 4096 bytes.
    // raw cooldown = 2 + 4096/128 = 34s; applied at 50% discount = 17s.
    // Plenty of time for the assertion to land.
    await sendBatch(sender, recipientNick, 16, 256);

    sender.clearRawBuffer();
    sender.send(`BATCH +second draft/multiline ${recipientNick}`);

    const fail = await sender.waitForFail('BATCH', 'MULTILINE_COOLDOWN', 5000);
    expect(fail.params[0]).toBe('BATCH');
    expect(fail.params[1]).toBe('MULTILINE_COOLDOWN');
    // Context param should be a positive integer of seconds remaining.
    const remaining = parseInt(fail.params[2], 10);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(60);
  });

  it('regular commands work during cooldown (multiline-only scope)', async () => {
    const { sender, recipientNick } = await setupSender();

    // Send a meaningful batch so we have cooldown.
    await sendBatch(sender, recipientNick, 16, 256);

    // PING immediately after — must PONG (cli_since not frozen).
    sender.clearRawBuffer();
    sender.send('PING :alive');
    const pong = await sender.waitForCommand('PONG', 3000);
    expect(pong.params[1]).toBe('alive');

    // A regular PRIVMSG also goes through.
    sender.clearRawBuffer();
    sender.send(`PRIVMSG ${recipientNick} :still talking`);
    // No error/kill within the wait window means the message went out.
    await new Promise(r => setTimeout(r, 400));
    const errLine = sender.allLines.find(l => /^ERROR :/.test(l));
    expect(errLine).toBeUndefined();
  });

  it('byte-cost gradient: 4KB batch yields larger cooldown than 1KB batch', async () => {
    // Two separate connections so each gets its own cooldown clock.
    const small = await setupSender();
    await sendBatch(small.sender, small.recipientNick, 4, 256); // ~1 KB
    small.sender.clearRawBuffer();
    small.sender.send(`BATCH +s draft/multiline ${small.recipientNick}`);
    const smallFail = await small.sender.waitForFail('BATCH', 'MULTILINE_COOLDOWN', 5000);
    const smallRemaining = parseInt(smallFail.params[2], 10);

    const big = await setupSender();
    await sendBatch(big.sender, big.recipientNick, 32, 256); // ~8 KB
    big.sender.clearRawBuffer();
    big.sender.send(`BATCH +b draft/multiline ${big.recipientNick}`);
    const bigFail = await big.sender.waitForFail('BATCH', 'MULTILINE_COOLDOWN', 5000);
    const bigRemaining = parseInt(bigFail.params[2], 10);

    // 8 KB cooldown must exceed 1 KB cooldown.  Gradient is monotone in
    // total_bytes: (2 + bytes/128) * 50/100 = bytes/256 + 1.
    expect(bigRemaining).toBeGreaterThan(smallRemaining);
  });

  it('cooldown expires and allows a follow-up batch', async () => {
    const { sender, recipientNick } = await setupSender();

    // Small batch so cooldown is brief and the test runs fast.
    // 2 lines × 64 bytes = ~128 bytes.  raw = 2 + 128/128 = 3s; applied
    // at 50% = 1-2s.
    await sendBatch(sender, recipientNick, 2, 64);

    // Wait beyond the cooldown.  Use 4s to be safe.
    await new Promise(r => setTimeout(r, 4000));

    sender.clearRawBuffer();
    sender.send(`BATCH +second draft/multiline ${recipientNick}`);
    sender.send(`@batch=second PRIVMSG ${recipientNick} :follow-up`);
    sender.send(`BATCH -second`);

    await new Promise(r => setTimeout(r, 400));
    const fail = sender.allLines.find(l =>
      /FAIL BATCH MULTILINE_COOLDOWN/.test(l)
    );
    expect(fail, 'no MULTILINE_COOLDOWN FAIL after cooldown expires').toBeUndefined();
  });

  it('rejected oversize batch does NOT incur cooldown', async () => {
    // process_multiline_batch's MULTILINE_MAX_BYTES reject path calls
    // clear_multiline_batch *without* invoking multiline_apply_cooldown.
    // A rejected batch never reached delivery, so charging cooldown
    // would be double-punishment.  Verify: trigger the reject, then
    // immediately open a normal batch — must succeed.
    const { sender, recipientNick } = await setupSender();

    // Build a batch that exceeds MULTILINE_MAX_BYTES (16384 default).
    // 70 lines × 250 bytes = 17500 bytes — over the cap.
    const batchId = `ovr${Date.now().toString(36)}`;
    const filler = 'o'.repeat(250);
    sender.send(`BATCH +${batchId} draft/multiline ${recipientNick}`);
    for (let i = 0; i < 70; i++) {
      sender.send(`@batch=${batchId} PRIVMSG ${recipientNick} :${filler}`);
    }
    sender.send(`BATCH -${batchId}`);

    // Wait for the FAIL MULTILINE_MAX_BYTES.
    const reject = await sender.waitForFail('BATCH', 'MULTILINE_MAX_BYTES', 5000);
    expect(reject.params[1]).toBe('MULTILINE_MAX_BYTES');

    // Now open a fresh, small batch — must NOT be cooldown-gated.
    await new Promise(r => setTimeout(r, 200));
    sender.clearRawBuffer();
    sender.send(`BATCH +after draft/multiline ${recipientNick}`);
    sender.send(`@batch=after PRIVMSG ${recipientNick} :should go through`);
    sender.send(`BATCH -after`);

    await new Promise(r => setTimeout(r, 500));
    const cooldownFail = sender.allLines.find(l =>
      /FAIL BATCH MULTILINE_COOLDOWN/.test(l)
    );
    expect(
      cooldownFail,
      'rejected oversize batch should not trigger cooldown for the next batch',
    ).toBeUndefined();
  });

  it('cli_since flat charge is small: PING+PONG within seconds of batch close', async () => {
    // The flat cli_since += MULTILINE_COOLDOWN_BASE (2s) charge keeps
    // multiline from being a complete fakelag bypass, but must not
    // freeze the connection.  Send a meaningful batch, then measure
    // PING→PONG round-trip — should complete well within 5s, which
    // would be impossible under the OLD per-line lag-accumulation
    // design where a 16KB batch could add 100+ seconds to cli_since.
    const { sender, recipientNick } = await setupSender();

    // 8KB batch — meaningful size.
    await sendBatch(sender, recipientNick, 32, 256);

    const t0 = Date.now();
    sender.clearRawBuffer();
    sender.send('PING :rtt-probe');
    await sender.waitForCommand('PONG', 5000);
    const rtt = Date.now() - t0;

    expect(
      rtt,
      `PING→PONG took ${rtt}ms after 8KB batch close; old design would freeze the connection for minutes`,
    ).toBeLessThan(5000);
  });

  it('empty batch (BATCH +ml + BATCH -) does NOT incur cooldown', async () => {
    // process_multiline_batch sees an empty message list and clears
    // state without delivery → no cooldown.  Verify: send empty
    // batch then immediately open another normal batch.
    const { sender, recipientNick } = await setupSender();

    sender.send(`BATCH +empty draft/multiline ${recipientNick}`);
    sender.send(`BATCH -empty`);
    await new Promise(r => setTimeout(r, 300));

    sender.clearRawBuffer();
    sender.send(`BATCH +second draft/multiline ${recipientNick}`);
    sender.send(`@batch=second PRIVMSG ${recipientNick} :ok`);
    sender.send(`BATCH -second`);

    await new Promise(r => setTimeout(r, 400));
    const cooldownFail = sender.allLines.find(l =>
      /FAIL BATCH MULTILINE_COOLDOWN/.test(l)
    );
    expect(
      cooldownFail,
      'empty batch (no delivery) should not produce cooldown',
    ).toBeUndefined();
  });

  it('replaced-batch (BATCH + while one already open) does NOT incur cooldown for the replaced content', async () => {
    // When a client opens a new BATCH + while one is already active,
    // clear_multiline_batch is called on the old batch to free state
    // — but multiline_apply_cooldown is NOT invoked, so the new batch
    // can open without being blocked by a phantom cooldown from
    // content that was never delivered.
    const { sender, recipientNick } = await setupSender();

    // Start a batch, send 4KB worth of lines, but DON'T close it.
    const filler = 'r'.repeat(256);
    sender.send(`BATCH +first draft/multiline ${recipientNick}`);
    for (let i = 0; i < 16; i++) {
      sender.send(`@batch=first PRIVMSG ${recipientNick} :${filler}`);
    }

    // Open a new batch without closing the first.  Server's m_batch
    // handler detects the existing open batch and calls
    // clear_multiline_batch — no cooldown should be applied.
    sender.send(`BATCH +second draft/multiline ${recipientNick}`);

    await new Promise(r => setTimeout(r, 400));
    const cooldownFail = sender.allLines.find(l =>
      /FAIL BATCH MULTILINE_COOLDOWN/.test(l)
    );
    expect(
      cooldownFail,
      'replaced (undelivered) batch should not produce cooldown for the replacement',
    ).toBeUndefined();

    // Close the second batch normally — that one SHOULD now produce cooldown.
    sender.send(`@batch=second PRIVMSG ${recipientNick} :replacement payload`);
    sender.send(`BATCH -second`);
    await new Promise(r => setTimeout(r, 300));

    // Try a third batch immediately — should now be cooldown-gated by
    // the second's close.
    sender.clearRawBuffer();
    sender.send(`BATCH +third draft/multiline ${recipientNick}`);
    const fail = await sender.waitForFail('BATCH', 'MULTILINE_COOLDOWN', 3000);
    expect(fail.params[1]).toBe('MULTILINE_COOLDOWN');
  });
});
