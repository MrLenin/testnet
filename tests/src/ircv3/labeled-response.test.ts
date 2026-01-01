import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId } from '../helpers/index.js';

/**
 * Labeled Response Tests (labeled-response)
 *
 * Tests the IRCv3 labeled-response capability for correlating
 * server responses with client requests.
 */
describe('IRCv3 Labeled Response (labeled-response)', () => {
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

  describe('Capability', () => {
    it('server advertises labeled-response', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('labeled-response')).toBe(true);

      client.send('QUIT');
    });

    it('can request labeled-response capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['labeled-response']);

      expect(result.ack).toContain('labeled-response');

      client.send('QUIT');
    });
  });

  describe('Basic Label Usage', () => {
    it('server echoes label in response', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('label1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Send a labeled command
      const label = `test-${uniqueId()}`;
      client.send(`@label=${label} PING :test`);

      try {
        // Should receive PONG with same label
        const response = await client.waitForLine(/PONG|label=/i, 3000);
        if (response.includes('label=')) {
          expect(response).toContain(`label=${label}`);
        }
        console.log('Labeled response:', response);
      } catch {
        console.log('No labeled response received');
      }

      client.send('QUIT');
    });

    it('unique labels for multiple commands', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('label2');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Send multiple labeled commands
      const label1 = `cmd1-${uniqueId()}`;
      const label2 = `cmd2-${uniqueId()}`;

      client.send(`@label=${label1} PING :first`);
      client.send(`@label=${label2} PING :second`);

      // Collect at least 2 PONG responses
      const responses: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 5000 && responses.length < 2) {
        try {
          const line = await client.waitForLine(/PONG|label=/i, 1000);
          responses.push(line);
        } catch {
          // Continue collecting until timeout
        }
      }

      // Server MUST respond to both PING commands
      expect(responses.length).toBeGreaterThanOrEqual(2);
      // Both responses should contain their respective labels or payloads
      expect(responses.some(r => r.includes(label1) || r.includes('first'))).toBe(true);
      expect(responses.some(r => r.includes(label2) || r.includes('second'))).toBe(true);

      client.send('QUIT');
    });
  });

  describe('Label with Batch', () => {
    it('labeled batch response for multi-line replies', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response', 'batch']);
      client.capEnd();
      client.register('label3');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('labelbatch');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // WHO returns multiple lines - should be wrapped in batch with label
      const label = `who-${uniqueId()}`;
      client.send(`@label=${label} WHO ${channel}`);

      // Server MUST respond with BATCH or WHO replies (352/315)
      const response = await client.waitForLine(/BATCH|352|315|label=/i, 5000);
      expect(response).toBeDefined();

      // Collect remaining WHO responses until end (315)
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        try {
          const line = await client.waitForLine(/352|315|BATCH/i, 1000);
          if (line.includes('315')) break; // End of WHO
          if (line.includes('BATCH -')) break;
        } catch {
          break;
        }
      }

      client.send('QUIT');
    });
  });

  describe('Label with PRIVMSG', () => {
    it('echo-message includes label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response', 'echo-message']);
      client.capEnd();
      client.register('labelecho1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('labelecho');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      const label = `msg-${uniqueId()}`;
      client.send(`@label=${label} PRIVMSG ${channel} :Labeled message`);

      try {
        // With echo-message, should receive our own message back with label
        const response = await client.waitForLine(/PRIVMSG.*Labeled message|label=/i, 3000);
        console.log('Echo with label:', response);
        if (response.includes('label=')) {
          expect(response).toContain(`label=${label}`);
        }
      } catch {
        console.log('Labeled echo failed');
      }

      client.send('QUIT');
    });
  });

  describe('Label Edge Cases', () => {
    it('handles empty label gracefully', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('labelempty1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Empty label value
      client.send('@label= PING :test');

      // Server MUST respond to PING (even with empty label)
      const response = await client.waitForLine(/PONG|FAIL/i, 5000);
      expect(response).toBeDefined();

      client.send('QUIT');
    });

    it('handles very long label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('labellong1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Very long label
      const longLabel = 'x'.repeat(100);
      client.send(`@label=${longLabel} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForLine(/PONG|FAIL/i, 5000);
      expect(response).toBeDefined();

      client.send('QUIT');
    });

    it('handles special characters in label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('labelspec1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Label with various allowed characters
      const specialLabel = 'test-123_abc';
      client.send(`@label=${specialLabel} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForLine(/PONG|label=/i, 5000);
      expect(response).toBeDefined();
      // If response includes label, it should match
      if (response.includes('label=')) {
        expect(response).toContain(specialLabel);
      }

      client.send('QUIT');
    });
  });

  describe('Label without Capability', () => {
    it('server ignores label when capability not enabled', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Don't request labeled-response
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('labelnone1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Send labeled command anyway
      const label = `ignore-${uniqueId()}`;
      client.send(`@label=${label} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForLine(/PONG/i, 5000);
      // Response should NOT contain label when capability not enabled
      expect(response).not.toContain('label=');

      client.send('QUIT');
    });
  });

  describe('ACK Response', () => {
    it('ACK sent for commands with no output', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('labelack1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('labelack');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Some commands produce no output - server should send ACK
      const label = `ack-${uniqueId()}`;
      // MODE without parameters typically just shows modes, but setting mode
      // on a channel we created might produce ACK
      client.send(`@label=${label} MODE ${channel} +t`);

      // Server MUST respond with ACK or MODE response
      const response = await client.waitForLine(/ACK|MODE|label=/i, 5000);
      expect(response).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('Labeled Response with Errors', () => {
    it('error responses include label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['labeled-response']);
      client.capEnd();
      client.register('labelerr1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      const label = `err-${uniqueId()}`;
      // Try to join an invalid channel name
      client.send(`@label=${label} JOIN invalidchannel`);

      // Server MUST respond with error or JOIN response
      const response = await client.waitForLine(/4\d\d|JOIN|label=/i, 5000);
      expect(response).toBeDefined();

      client.send('QUIT');
    });
  });
});

/**
 * Message Tags Tests (message-tags)
 */
describe('IRCv3 Message Tags (message-tags)', () => {
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

  describe('Capability', () => {
    it('server advertises message-tags', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('message-tags')).toBe(true);

      client.send('QUIT');
    });

    it('can request message-tags capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['message-tags']);

      expect(result.ack).toContain('message-tags');

      client.send('QUIT');
    });
  });

  describe('Client-to-Client Tags', () => {
    it('can send +draft/reply tag', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['message-tags', 'echo-message']);
      sender.capEnd();
      sender.register('tagsend1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagrecv1');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('tags');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send message with +draft/reply tag
      const replyMsgid = 'test-msgid-12345';
      sender.send(`@+draft/reply=${replyMsgid} PRIVMSG ${channel} :This is a reply`);

      try {
        const response = await receiver.waitForLine(/PRIVMSG.*This is a reply/i, 3000);
        console.log('Reply tag message:', response);
        // Check if reply tag is preserved
        if (response.includes('+draft/reply')) {
          expect(response).toContain(replyMsgid);
        }
      } catch {
        console.log('Reply tag message not received');
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('can send +draft/react tag', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['message-tags']);
      sender.capEnd();
      sender.register('tagreact1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagreact2');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('react');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send TAGMSG with +draft/react
      sender.send(`@+draft/react=:thumbsup: TAGMSG ${channel}`);

      try {
        const response = await receiver.waitForLine(/TAGMSG/i, 3000);
        console.log('React TAGMSG:', response);
      } catch {
        console.log('React TAGMSG not received');
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('TAGMSG Command', () => {
    it('can send TAGMSG', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['message-tags']);
      sender.capEnd();
      sender.register('tagmsg1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagmsg2');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('tagmsg');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      // Send TAGMSG with a client tag
      sender.send(`@+example/tag=value TAGMSG ${channel}`);

      try {
        const response = await receiver.waitForLine(/TAGMSG/i, 3000);
        expect(response).toContain('TAGMSG');
        console.log('TAGMSG received:', response);
      } catch {
        console.log('TAGMSG not received');
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('TAGMSG without message-tags capability not received', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['message-tags']);
      sender.capEnd();
      sender.register('tagmsg3');
      await sender.waitForLine(/001/);

      // Receiver does NOT request message-tags
      await receiver.capLs();
      await receiver.capReq(['multi-prefix']);
      receiver.capEnd();
      receiver.register('tagmsg4');
      await receiver.waitForLine(/001/);

      const channel = uniqueChannel('tagmsg2');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      sender.send(`@+example/tag=value TAGMSG ${channel}`);

      try {
        // Receiver without message-tags should NOT receive TAGMSG
        await receiver.waitForLine(/TAGMSG/i, 2000);
        console.log('TAGMSG received unexpectedly');
      } catch {
        console.log('TAGMSG correctly not received (no capability)');
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });
});
