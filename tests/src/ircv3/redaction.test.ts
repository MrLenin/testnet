import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl.js';
import { getTestAccount, releaseTestAccount } from '../helpers/x3-client.js';

/**
 * Message Redaction Tests (draft/message-redaction)
 *
 * Tests the IRCv3 message redaction specification for deleting messages.
 * REDACT requires authentication (ACCOUNT_REQUIRED).
 * - Authenticated users can redact their own messages (no time window)
 * - Authenticated chanops can redact any message (time window)
 * - IRC operators can redact any message (oper window)
 */
describe('IRCv3 Message Redaction (draft/message-redaction)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  /**
   * Helper to create an authenticated client with redaction caps.
   */
  async function createAuthClient(
    nick: string,
    extraCaps: string[] = []
  ): Promise<RawSocketClient> {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    const client = trackClient(await createRawSocketClient());
    await client.capLs();
    await client.capReq(['sasl', 'draft/message-redaction', ...extraCaps]);

    const result = await authenticateSaslPlain(client, account, password);
    if (!result.success) {
      throw new Error(`SASL auth failed for ${account}: ${result.error}`);
    }

    client.capEnd();
    client.register(nick);
    await client.waitForNumeric('001');
    return client;
  }

  /**
   * Helper to send a message and capture its msgid from echo-message.
   * Throws if msgid cannot be captured (test should fail).
   */
  async function sendAndCaptureMsgid(
    client: RawSocketClient,
    channel: string,
    message: string
  ): Promise<string> {
    client.send(`PRIVMSG ${channel} :${message}`);

    const echo = await client.waitForParsedLine(
      msg => msg.command === 'PRIVMSG' && msg.raw.includes(message),
      5000
    );

    const match = echo.raw.match(/msgid=([^\s;]+)/);
    if (!match) {
      throw new Error(`No msgid in echo: ${echo.raw}`);
    }
    return match[1];
  }

  describe('Capability', () => {
    it('server advertises draft/message-redaction', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/message-redaction')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/message-redaction capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/message-redaction']);

      expect(result.ack).toContain('draft/message-redaction');

      client.send('QUIT');
    });
  });

  describe('REDACT Command', () => {
    it('can redact own message with REDACT', { retry: 2 }, async () => {
      const client = await createAuthClient('redact1', ['echo-message']);

      const channel = uniqueChannel('redact');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      // Send message and capture msgid
      const msgid = await sendAndCaptureMsgid(client, channel, 'Message to be redacted');

      client.clearRawBuffer();

      // Redact the message
      client.send(`REDACT ${channel} ${msgid}`);

      // Should receive REDACT confirmation (echo back to self)
      const response = await client.waitForCommand('REDACT', 5000);
      expect(response.command).toBe('REDACT');
      expect(response.raw).toContain(msgid);

      client.send('QUIT');
    });

    it('REDACT with reason is accepted', { retry: 2 }, async () => {
      const sender = await createAuthClient('redsend1', ['echo-message']);
      const receiver = await createAuthClient('redrecv1');

      const channel = uniqueChannel('redreason');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);

      // Send message
      const msgid = await sendAndCaptureMsgid(sender, channel, 'This will be redacted');

      receiver.clearRawBuffer();

      // Redact with reason (sender is chanop, first to join)
      sender.send(`REDACT ${channel} ${msgid} :Posted by mistake`);

      // Receiver should get REDACT notification
      const notification = await receiver.waitForCommand('REDACT', 5000);
      expect(notification.command).toBe('REDACT');
      expect(notification.raw).toContain(msgid);

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('REDACT Permissions', () => {
    it('cannot redact other user message without op', { retry: 2 }, async () => {
      const sender = await createAuthClient('redsender2', ['echo-message']);
      const attacker = await createAuthClient('redattack1', ['standard-replies']);

      const channel = uniqueChannel('redperm');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      // Sender is now op, let attacker join
      attacker.send(`JOIN ${channel}`);
      await attacker.waitForJoin(channel);

      // Sender sends message
      const msgid = await sendAndCaptureMsgid(sender, channel, 'Protected message');

      attacker.clearRawBuffer();

      // Attacker tries to redact sender's message - should fail
      // (different account, not chanop)
      attacker.send(`REDACT ${channel} ${msgid}`);

      // Should receive FAIL or error numeric, NOT a successful REDACT
      const response = await attacker.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      // Verify it's an error response
      expect(response.command === 'FAIL' || /^4\d\d$/.test(response.command)).toBe(true);

      sender.send('QUIT');
      attacker.send('QUIT');
    });

    it('op can redact any message in channel', { retry: 2 }, async () => {
      const op = await createAuthClient('redop1', ['echo-message']);
      const user = await createAuthClient('reduser1', ['echo-message']);

      const channel = uniqueChannel('redop');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);

      user.send(`JOIN ${channel}`);
      await user.waitForJoin(channel);

      // User sends message
      const msgid = await sendAndCaptureMsgid(user, channel, 'User message');

      op.clearRawBuffer();

      // Op redacts user's message - should succeed (chanop privilege)
      op.send(`REDACT ${channel} ${msgid} :Moderation action`);

      const response = await op.waitForCommand('REDACT', 5000);
      expect(response.command).toBe('REDACT');
      expect(response.raw).toContain(msgid);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('REDACT Edge Cases', () => {
    it('REDACT nonexistent msgid returns error', { retry: 2 }, async () => {
      const client = await createAuthClient('redinv1', ['standard-replies']);

      const channel = uniqueChannel('redinv');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      client.clearRawBuffer();

      // Try to redact nonexistent message
      client.send(`REDACT ${channel} nonexistent-msgid-12345`);

      // Should receive FAIL or error numeric
      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      expect(response.command === 'FAIL' || /^4\d\d$/.test(response.command)).toBe(true);

      client.send('QUIT');
    });

    it('REDACT same message twice returns error on second attempt', { retry: 2 }, async () => {
      const client = await createAuthClient('redtwice1', ['echo-message', 'standard-replies']);

      const channel = uniqueChannel('redtwice');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      const msgid = await sendAndCaptureMsgid(client, channel, 'Double redact test');

      // First redact - should succeed
      client.clearRawBuffer();
      client.send(`REDACT ${channel} ${msgid}`);

      const firstResponse = await client.waitForCommand('REDACT', 5000);
      expect(firstResponse.command).toBe('REDACT');

      await new Promise(r => setTimeout(r, 300));

      // Second redact of same message - should fail
      client.clearRawBuffer();
      client.send(`REDACT ${channel} ${msgid}`);

      const secondResponse = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      expect(secondResponse.command === 'FAIL' || /^4\d\d$/.test(secondResponse.command)).toBe(true);

      client.send('QUIT');
    });
  });

  describe('REDACT Notification', () => {
    it('other channel members receive REDACT notification', { retry: 2 }, async () => {
      const redactor = await createAuthClient('rednote1', ['echo-message']);
      const observer = await createAuthClient('redobs1');

      const channel = uniqueChannel('rednote');
      redactor.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await redactor.waitForJoin(channel);
      await observer.waitForJoin(channel);

      const msgid = await sendAndCaptureMsgid(redactor, channel, 'Message to be seen redacted');

      observer.clearRawBuffer();

      redactor.send(`REDACT ${channel} ${msgid}`);

      // Observer should receive REDACT notification
      const notification = await observer.waitForCommand('REDACT', 5000);
      expect(notification.command).toBe('REDACT');
      expect(notification.raw).toContain(channel);
      expect(notification.raw).toContain(msgid);

      redactor.send('QUIT');
      observer.send('QUIT');
    });
  });
});
