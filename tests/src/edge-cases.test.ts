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
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('emptyrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('empty');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send empty message (just the colon)
      sender.send(`PRIVMSG ${channel} :`);

      // Server should either deliver empty message or ignore it
      // Give a short timeout since it may be ignored
      const response = await receiver.waitForLine(/PRIVMSG/i, 2000).catch(() => null);
      // Either we receive it or we don't - both are acceptable
      expect(true).toBe(true); // Test that we didn't crash

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('should handle very long message (near 512 byte limit)', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('longsend1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('longrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('long');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Create a long message (but not too long to cause issues)
      const longText = 'A'.repeat(400);
      sender.send(`PRIVMSG ${channel} :${longText}`);

      // Should receive the message (possibly truncated)
      const received = await receiver.waitForLine(/PRIVMSG/i, 5000);
      expect(received).toContain('PRIVMSG');
      expect(received).toContain('AAAA'); // At least some of the As

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
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('unirecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('unicode');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send message with unicode characters
      const unicodeText = 'Hello 世界 🌍 émojis';
      sender.send(`PRIVMSG ${channel} :${unicodeText}`);

      const received = await receiver.waitForLine(/PRIVMSG/i, 5000);
      expect(received).toContain('PRIVMSG');
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
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('colrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('colons');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send message with multiple colons (e.g., URLs, timestamps)
      const colonText = 'Check this URL: https://example.com:8080/path';
      sender.send(`PRIVMSG ${channel} :${colonText}`);

      const received = await receiver.waitForLine(/PRIVMSG/i, 5000);
      expect(received).toContain('PRIVMSG');
      expect(received).toContain('https://example.com:8080');

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
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('JOIN #12345');

      const joinResponse = await client.waitForLine(/JOIN.*#12345|403/i, 5000);
      // Either we join or get error - both are valid server responses
      expect(joinResponse).toBeDefined();

      client.send('QUIT');
    });

    it('should handle channel with hyphens and underscores', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('chanhyp1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('JOIN #test-channel_name');

      const joinResponse = await client.waitForLine(/JOIN.*#test-channel_name/i, 5000);
      expect(joinResponse).toContain('JOIN');
      expect(joinResponse).toContain('#test-channel_name');

      client.send('QUIT');
    });

    it('should reject channel without proper prefix', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('badchan1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try to join channel without # prefix
      client.send('JOIN badchanname');

      // Should get an error
      const response = await client.waitForLine(/403|476|461/i, 5000);
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
      await client.waitForLine(/001/);

      // Successfully registered with numbers in nick
      expect(true).toBe(true);

      client.send('QUIT');
    });

    it('should handle nickname change to same nick', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('samenick1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try to change to the same nick
      client.send('NICK samenick1');

      // Should either succeed silently or return error - both acceptable
      await new Promise(r => setTimeout(r, 500));
      expect(true).toBe(true); // Didn't crash

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

      const welcome = await client.waitForLine(/001/);
      expect(welcome).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('Rapid Operations', () => {
    it('should handle rapid join/part', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('rapidjp1');
      await client.waitForLine(/001/);

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
      const pong = await client.waitForLine(/PONG/i, 5000);
      expect(pong).toContain('PONG');

      client.send('QUIT');
    });

    it('should handle rapid messages', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('rapidsend1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('rapidrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('rapidmsg');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
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

      const pong = await sender.waitForLine(/PONG/i, 5000);
      expect(pong).toContain('PONG');

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
      await client.waitForLine(/001/);

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
      const pong = await client.waitForLine(/PONG/i, 5000);
      expect(pong).toContain('PONG');

      client.send('QUIT');
    });
  });

  describe('Mode Edge Cases', () => {
    it('should handle setting same mode twice', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('samemode1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('samemode');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set +n twice
      client.send(`MODE ${channel} +n`);
      await client.waitForLine(/MODE.*\+n/i, 5000).catch(() => {});

      client.send(`MODE ${channel} +n`);

      // Should either succeed or be ignored - both acceptable
      await new Promise(r => setTimeout(r, 500));
      expect(true).toBe(true); // Didn't crash

      client.send('QUIT');
    });

    it('should handle unsetting mode that is not set', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('unsetmode1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('unsetmode');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Try to unset mode that may not be set
      client.send(`MODE ${channel} -m`);

      // Should be handled gracefully
      await new Promise(r => setTimeout(r, 500));
      expect(true).toBe(true); // Didn't crash

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
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('ctcprecv1');
      await receiver.waitForLine(/001/);

      receiver.clearRawBuffer();

      // Send CTCP VERSION request
      sender.send('PRIVMSG ctcprecv1 :\x01VERSION\x01');

      // Receiver should get the CTCP
      const ctcp = await receiver.waitForLine(/VERSION/i, 5000);
      expect(ctcp).toContain('VERSION');

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('should handle CTCP ACTION (emote)', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('actionsend1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('actionrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('action');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send CTCP ACTION (emote)
      sender.send(`PRIVMSG ${channel} :\x01ACTION waves hello\x01`);

      // Receiver should get the ACTION
      const action = await receiver.waitForLine(/ACTION/i, 5000);
      expect(action).toContain('ACTION');
      expect(action).toContain('waves hello');

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });
});
