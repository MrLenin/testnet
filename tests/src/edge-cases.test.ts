import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId } from './helpers/index.js';

/**
 * Edge Case Tests
 *
 * Tests for boundary conditions, special inputs, and unusual scenarios.
 * These tests verify the server handles edge cases gracefully.
 */
describe('Edge Cases', () => {
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

  describe('Message Length', () => {
    it('should handle empty PRIVMSG gracefully', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('emptysend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('emptyrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('empty');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send empty message (just the colon)
      sender.clearRawBuffer();
      sender.send(`PRIVMSG ${channel} :`);

      // DOCUMENTED BEHAVIOR:
      // Nefarious returns ERR_NOTEXTTOSEND (412) for empty messages
      // per RFC 1459: "No text to send"
      // The message is NOT relayed - this is correct per spec
      const errorResponse = await sender.waitForNumeric('412', 5000);
      expect(errorResponse.command).toBe('412');

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('should handle very long message (near 512 byte limit)', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('longsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('longrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('long');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Create a long message (but not too long to cause issues)
      const longText = 'A'.repeat(400);
      sender.send(`PRIVMSG ${channel} :${longText}`);

      // Should receive the message (possibly truncated)
      const received = await receiver.waitForCommand('PRIVMSG', 5000);
      expect(received.command).toBe('PRIVMSG');
      expect(received.raw).toContain('AAAA'); // At least some of the As

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('Special Characters', () => {
    it('should handle messages with unicode', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('unisend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('unirecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('unicode');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send message with unicode characters
      const unicodeText = 'Hello 世界 🌍 émojis';
      sender.send(`PRIVMSG ${channel} :${unicodeText}`);

      const received = await receiver.waitForCommand('PRIVMSG', 5000);
      expect(received.command).toBe('PRIVMSG');
      // The message should be delivered (content may vary by encoding)

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('should handle message with multiple colons', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('colsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('colrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('colons');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send message with multiple colons (e.g., URLs, timestamps)
      const colonText = 'Check this URL: https://example.com:8080/path';
      sender.send(`PRIVMSG ${channel} :${colonText}`);

      const received = await receiver.waitForCommand('PRIVMSG', 5000);
      expect(received.command).toBe('PRIVMSG');
      expect(received.raw).toContain('https://example.com:8080');

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('Channel Name Edge Cases', () => {
    it('should handle channel with numbers', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('channum1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      client.send('JOIN #12345');

      const joinResponse = await client.waitForParsedLine(
        msg => (msg.command === 'JOIN' && msg.raw.includes('#12345')) || msg.command === '403',
        5000
      );
      // Either we join or get error - both are valid server responses
      expect(joinResponse).toBeDefined();

      client.send('QUIT');
    });

    it('should handle channel with hyphens and underscores', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('chanhyp1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      client.send('JOIN #test-channel_name');

      const joinResponse = await client.waitForJoin('#test-channel_name', undefined, 5000);
      expect(joinResponse.command).toBe('JOIN');
      expect(joinResponse.raw).toContain('#test-channel_name');

      client.send('QUIT');
    });

    it('should reject channel without proper prefix', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('badchan1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Try to join channel without # prefix
      client.send('JOIN badchanname');

      // Should get an error
      const response = await client.waitForParsedLine(
        msg => ['403', '476', '461'].includes(msg.command),
        5000
      );
      expect(response).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('Nickname Edge Cases', () => {
    it('should handle nickname with numbers', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('user12345');
      const welcome = await client.waitForNumeric('001');

      // Verify the nick was accepted with numbers
      expect(welcome.command).toBe('001');
      expect(welcome.raw).toContain('user12345');

      client.send('QUIT');
    });

    it('should handle nickname change to same nick', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('samenick1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Try to change to the same nick
      client.send('NICK samenick1');

      // Server should either: silently ignore, send NICK confirmation, or error
      // Verify we can still operate by sending PING
      await new Promise(r => setTimeout(r, 300));
      client.send('PING :sametest');
      const pong = await client.waitForParsedLine(
        msg => msg.command === 'PONG' && msg.raw.includes('sametest'),
        5000
      );
      expect(pong.command).toBe('PONG');

      client.send('QUIT');
    });

    it('should handle nickname with maximum allowed length', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();

      // Most servers allow 9-30 character nicks
      // Use 9 characters as a safe maximum
      const longNick = 'abcdefghi';
      client.register(longNick);

      const welcome = await client.waitForNumeric('001');
      expect(welcome.command).toBe('001');

      client.send('QUIT');
    });
  });

  describe('Rapid Operations', () => {
    it('should handle rapid join/part', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('rapidjp1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('rapid');

      // Rapidly join and part
      for (let i = 0; i < 5; i++) {
        client.send(`JOIN ${channel}`);
        client.send(`PART ${channel}`);
      }

      // Wait a bit and verify we're still connected
      await new Promise(r => setTimeout(r, 1000));

      client.clearRawBuffer();

      // Verify we can still operate
      client.send('PING :test');
      const pong = await client.waitForCommand('PONG', 5000);
      expect(pong.command).toBe('PONG');

      client.send('QUIT');
    });

    it('should handle rapid messages', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('rapidsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('rapidrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('rapidmsg');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Send multiple messages rapidly
      for (let i = 0; i < 10; i++) {
        sender.send(`PRIVMSG ${channel} :Message ${i}`);
      }

      // Wait for potential flood protection
      await new Promise(r => setTimeout(r, 2000));

      // Verify still connected
      sender.clearRawBuffer();
      sender.send('PING :stillalive');

      const pong = await sender.waitForCommand('PONG', 5000);
      expect(pong.command).toBe('PONG');

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('Channel Limit Cases', () => {
    it('should handle user joining multiple channels', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('multichan1');
      await client.waitForNumeric('001');

      // Join multiple channels
      const channels = [];
      for (let i = 0; i < 5; i++) {
        const channel = `#multi-${uniqueId()}`;
        channels.push(channel);
        client.send(`JOIN ${channel}`);
      }

      // Wait for all joins
      await new Promise(r => setTimeout(r, 2000));

      // Verify we're still connected
      client.clearRawBuffer();
      client.send('PING :multichan');
      const pong = await client.waitForCommand('PONG', 5000);
      expect(pong.command).toBe('PONG');

      client.send('QUIT');
    });
  });

  describe('Mode Edge Cases', () => {
    it('should handle setting same mode twice', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('samemode1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('samemode');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // First remove +m so we can set it, then set twice
      client.send(`MODE ${channel} -m`);
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();

      client.send(`MODE ${channel} +m`);
      await client.waitForParsedLine(
        msg => msg.command === 'MODE' && msg.raw.includes('+m'),
        5000
      );

      client.clearRawBuffer();
      client.send(`MODE ${channel} +m`);

      // Second set of same mode should be silently ignored (no MODE echo)
      // Verify by checking we can still query modes
      await new Promise(r => setTimeout(r, 300));
      client.send(`MODE ${channel}`);
      const modeResponse = await client.waitForParsedLine(
        msg => msg.command === '324' || msg.command === 'MODE',
        5000
      );
      expect(modeResponse).toBeDefined();

      client.send('QUIT');
    });

    it('should handle unsetting mode that is not set', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('unsetmode1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('unsetmode');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Ensure -m is not set first, then try to unset it again
      client.send(`MODE ${channel} -m`);
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();

      // Try to unset mode that is definitely not set
      client.send(`MODE ${channel} -m`);

      // Server should silently ignore or no-op
      // Verify by checking we can still query modes
      await new Promise(r => setTimeout(r, 300));
      client.send(`MODE ${channel}`);
      const modeResponse = await client.waitForParsedLine(
        msg => msg.command === '324' || msg.command === 'MODE',
        5000
      );
      expect(modeResponse).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('CTCP', () => {
    it('should handle CTCP VERSION', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('ctcpsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('ctcprecv1');
      await receiver.waitForNumeric('001');

      receiver.clearRawBuffer();

      // Send CTCP VERSION request
      sender.send('PRIVMSG ctcprecv1 :\x01VERSION\x01');

      // Receiver should get the CTCP
      const ctcp = await receiver.waitForParsedLine(
        msg => msg.raw.includes('VERSION'),
        5000
      );
      expect(ctcp.raw).toContain('VERSION');

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('should handle CTCP ACTION (emote)', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('actionsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('actionrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('action');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send CTCP ACTION (emote)
      sender.send(`PRIVMSG ${channel} :\x01ACTION waves hello\x01`);

      // Receiver should get the ACTION
      const action = await receiver.waitForParsedLine(
        msg => msg.raw.includes('ACTION'),
        5000
      );
      expect(action.raw).toContain('ACTION');
      expect(action.raw).toContain('waves hello');

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });
});
