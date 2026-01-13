import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';

/**
 * Message Redaction Tests (draft/message-redaction)
 *
 * Tests the IRCv3 message redaction specification for deleting messages.
 * Allows users to remove their own messages or ops to remove any message.
 */
describe('IRCv3 Message Redaction (draft/message-redaction)', () => {
  const clients: RawSocketClient[] = [];

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
  });

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
    it('can redact own message with REDACT', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message']);
      client.capEnd();
      client.register('redact1');
      await client.waitForNumeric('001');

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

    it('REDACT with reason is accepted', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message']);
      sender.capEnd();
      sender.register('redsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['draft/message-redaction']);
      receiver.capEnd();
      receiver.register('redrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('redreason');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Send message
      const msgid = await sendAndCaptureMsgid(sender, channel, 'This will be redacted');

      receiver.clearRawBuffer();

      // Redact with reason
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
    it('cannot redact other user message without op', async () => {
      const sender = trackClient(await createRawSocketClient());
      const attacker = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message']);
      sender.capEnd();
      sender.register('redsender2');
      await sender.waitForNumeric('001');

      await attacker.capLs();
      await attacker.capReq(['draft/message-redaction']);
      attacker.capEnd();
      attacker.register('redattack1');
      await attacker.waitForNumeric('001');

      const channel = uniqueChannel('redperm');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      // Sender is now op, let attacker join
      attacker.send(`JOIN ${channel}`);
      await attacker.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Sender sends message
      const msgid = await sendAndCaptureMsgid(sender, channel, 'Protected message');

      attacker.clearRawBuffer();

      // Attacker tries to redact sender's message - should fail
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

    it('op can redact any message in channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/message-redaction']);
      op.capEnd();
      op.register('redop1');
      await op.waitForNumeric('001');

      await user.capLs();
      await user.capReq(['draft/message-redaction', 'echo-message']);
      user.capEnd();
      user.register('reduser1');
      await user.waitForNumeric('001');

      const channel = uniqueChannel('redop');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);

      user.send(`JOIN ${channel}`);
      await user.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // User sends message
      const msgid = await sendAndCaptureMsgid(user, channel, 'User message');

      op.clearRawBuffer();

      // Op redacts user's message - should succeed
      op.send(`REDACT ${channel} ${msgid} :Moderation action`);

      const response = await op.waitForCommand('REDACT', 5000);
      expect(response.command).toBe('REDACT');
      expect(response.raw).toContain(msgid);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('REDACT Edge Cases', () => {
    it('REDACT nonexistent msgid returns error', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction']);
      client.capEnd();
      client.register('redinv1');
      await client.waitForNumeric('001');

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

    it('REDACT same message twice returns error on second attempt', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message']);
      client.capEnd();
      client.register('redtwice1');
      await client.waitForNumeric('001');

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
    it('other channel members receive REDACT notification', async () => {
      const redactor = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await redactor.capLs();
      await redactor.capReq(['draft/message-redaction', 'echo-message']);
      redactor.capEnd();
      redactor.register('rednote1');
      await redactor.waitForNumeric('001');

      await observer.capLs();
      await observer.capReq(['draft/message-redaction']);
      observer.capEnd();
      observer.register('redobs1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('rednote');
      redactor.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await redactor.waitForJoin(channel);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

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
