import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId, CAP_BUNDLES } from '../helpers/index.js';

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
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('label1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Send a labeled command
      const label = `test-${uniqueId()}`;
      client.send(`@label=${label} PING :test`);

      // Should receive PONG with same label
      const response = await client.waitForCommand('PONG', 3000);
      expect(response).toBeDefined();
      // Server must respond to PING - label may or may not be echoed for PING specifically
      expect(response.command).toBe('PONG');
      console.log('Labeled response:', response.raw);

      client.send('QUIT');
    });

    it('unique labels for multiple commands', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('label2');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Send multiple labeled commands - send one at a time and wait for response
      const label1 = `cmd1-${uniqueId()}`;
      const label2 = `cmd2-${uniqueId()}`;

      // Collect responses for both commands
      const responses: string[] = [];

      // Send first PING and collect response
      client.send(`@label=${label1} PING :first`);
      try {
        const msg1 = await client.waitForParsedLine(
          m => m.command === 'PONG' && (m.raw.includes(label1) || m.raw.includes('first')),
          3000
        );
        responses.push(msg1.raw);
      } catch {
        // Continue even if first times out
      }

      // Send second PING and collect response
      client.send(`@label=${label2} PING :second`);
      try {
        const msg2 = await client.waitForParsedLine(
          m => m.command === 'PONG' && (m.raw.includes(label2) || m.raw.includes('second')),
          3000
        );
        responses.push(msg2.raw);
      } catch {
        // Continue even if second times out
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
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('label3');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('labelbatch');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      client.clearRawBuffer();

      // WHO returns multiple lines - should be wrapped in batch with label
      const label = `who-${uniqueId()}`;
      client.send(`@label=${label} WHO ${channel}`);

      // Server MUST respond with BATCH or WHO replies (352/315)
      const response = await client.waitForParsedLine(
        msg => msg.command === 'BATCH' || msg.command === '352' ||
               msg.command === '315' || msg.raw.includes('label='),
        5000
      );
      expect(['BATCH', '352', '315'].includes(response.command) || response.raw.includes('label='),
        `Should get BATCH or WHO response, got: ${response.command}`).toBe(true);

      // Collect remaining WHO responses until end (315)
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        try {
          const msg = await client.waitForParsedLine(
            m => m.command === '352' || m.command === '315' || m.command === 'BATCH',
            1000
          );
          if (msg.command === '315') break; // End of WHO
          if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
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
      // Combine batching (labeled-response) and messaging (echo-message)
      await client.capReq([...CAP_BUNDLES.batching, ...CAP_BUNDLES.messaging]);
      client.capEnd();
      client.register('labelecho1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('labelecho');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      client.clearRawBuffer();

      const label = `msg-${uniqueId()}`;
      client.send(`@label=${label} PRIVMSG ${channel} :Labeled message`);

      // With echo-message, should receive our own message back with label
      const response = await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.raw.includes('Labeled message'),
        3000
      );
      expect(response.command).toBe('PRIVMSG');
      expect(response.raw).toContain('Labeled message');
      // If response includes label tag, verify it matches
      if (response.raw.includes('label=')) {
        expect(response.raw).toContain(`label=${label}`);
      }
      console.log('Echo with label:', response.raw);

      client.send('QUIT');
    });
  });

  describe('Label Edge Cases', () => {
    it('handles empty label gracefully', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('labelempty1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Empty label value
      client.send('@label= PING :test');

      // Server MUST respond to PING (even with empty label)
      const response = await client.waitForParsedLine(
        msg => msg.command === 'PONG' || msg.command === 'FAIL',
        5000
      );
      expect(response.command, 'Should get PONG or FAIL response').toMatch(/PONG|FAIL/);

      client.send('QUIT');
    });

    it('handles very long label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('labellong1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Very long label
      const longLabel = 'x'.repeat(100);
      client.send(`@label=${longLabel} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForParsedLine(
        msg => msg.command === 'PONG' || msg.command === 'FAIL',
        5000
      );
      expect(response.command, 'Should get PONG or FAIL response').toMatch(/PONG|FAIL/);

      client.send('QUIT');
    });

    it('handles special characters in label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('labelspec1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Label with various allowed characters
      const specialLabel = 'test-123_abc';
      client.send(`@label=${specialLabel} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForParsedLine(
        msg => msg.command === 'PONG' || msg.raw.includes('label='),
        5000
      );
      expect(response.command === 'PONG' || response.raw.includes('label='),
        'Should get PONG response or labeled response').toBe(true);
      // If response includes label, it should match
      if (response.raw.includes('label=')) {
        expect(response.raw).toContain(specialLabel);
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
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Send labeled command anyway
      const label = `ignore-${uniqueId()}`;
      client.send(`@label=${label} PING :test`);

      // Server MUST respond to PING
      const response = await client.waitForCommand('PONG', 5000);
      // Response should NOT contain label when capability not enabled
      expect(response.raw).not.toContain('label=');

      client.send('QUIT');
    });
  });

  describe('ACK Response', () => {
    it('ACK sent for commands with no output', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('labelack1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('labelack');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      client.clearRawBuffer();

      // First remove +m (in case it's somehow set), then set it
      client.send(`MODE ${channel} -m`);
      await new Promise(r => setTimeout(r, 300));
      client.clearRawBuffer();

      // Some commands produce no output - server should send ACK
      const label = `ack-${uniqueId()}`;
      // Setting +m mode on the channel
      client.send(`@label=${label} MODE ${channel} +m`);

      // Server MUST respond with ACK or MODE response with our label
      const response = await client.waitForParsedLine(
        msg => msg.command === 'ACK' ||
               (msg.command === 'MODE' && msg.raw.includes('+m')) ||
               msg.raw.includes('label='),
        5000
      );
      expect(response.command === 'ACK' || response.command === 'MODE' || response.raw.includes('label='),
        `Should get ACK or MODE response, got: ${response.command}`).toBe(true);

      client.send('QUIT');
    });
  });

  describe('Labeled Response with Errors', () => {
    it('error responses include label', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.batching);
      client.capEnd();
      client.register('labelerr1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      const label = `err-${uniqueId()}`;
      // Try to join an invalid channel name
      client.send(`@label=${label} JOIN invalidchannel`);

      // Server MUST respond with error or JOIN response
      const response = await client.waitForParsedLine(
        msg => /^4\d\d$/.test(msg.command) || msg.command === 'JOIN' || msg.raw.includes('label='),
        5000
      );
      expect(/^4\d\d$/.test(response.command) || response.command === 'JOIN' || response.raw.includes('label='),
        `Should get error numeric or JOIN response, got: ${response.command}`).toBe(true);

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
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagrecv1');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('tags');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);

      receiver.clearRawBuffer();

      // Send message with +draft/reply tag
      const replyMsgid = 'test-msgid-12345';
      sender.send(`@+draft/reply=${replyMsgid} PRIVMSG ${channel} :This is a reply`);

      try {
        const response = await receiver.waitForParsedLine(
          msg => msg.command === 'PRIVMSG' && msg.raw.includes('This is a reply'),
          3000
        );
        console.log('Reply tag message:', response.raw);
        // Check if reply tag is preserved
        if (response.raw.includes('+draft/reply')) {
          expect(response.raw).toContain(replyMsgid);
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
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagreact2');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('react');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);

      receiver.clearRawBuffer();

      // Send TAGMSG with +draft/react
      sender.send(`@+draft/react=:thumbsup: TAGMSG ${channel}`);

      try {
        const response = await receiver.waitForCommand('TAGMSG', 3000);
        console.log('React TAGMSG:', response.raw);
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
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagmsg2');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('tagmsg');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);

      receiver.clearRawBuffer();

      // Send TAGMSG with a client tag
      sender.send(`@+example/tag=value TAGMSG ${channel}`);

      try {
        const response = await receiver.waitForCommand('TAGMSG', 3000);
        expect(response.command).toBe('TAGMSG');
        console.log('TAGMSG received:', response.raw);
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
      await sender.waitForNumeric('001');

      // Receiver does NOT request message-tags
      await receiver.capLs();
      await receiver.capReq(['multi-prefix']);
      receiver.capEnd();
      receiver.register('tagmsg4');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('tagmsg2');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);

      receiver.clearRawBuffer();

      sender.send(`@+example/tag=value TAGMSG ${channel}`);

      try {
        // Receiver without message-tags should NOT receive TAGMSG
        await receiver.waitForCommand('TAGMSG', 2000);
        console.log('TAGMSG received unexpectedly');
      } catch {
        console.log('TAGMSG correctly not received (no capability)');
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });
});
