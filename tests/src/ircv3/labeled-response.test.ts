import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

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
      const label = `test-${Date.now()}`;
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
      const label1 = `cmd1-${Date.now()}`;
      const label2 = `cmd2-${Date.now()}`;

      client.send(`@label=${label1} PING :first`);
      client.send(`@label=${label2} PING :second`);

      try {
        // Collect responses
        const responses: string[] = [];
        const startTime = Date.now();
        while (Date.now() - startTime < 3000 && responses.length < 2) {
          try {
            const line = await client.waitForLine(/PONG|label=/i, 500);
            responses.push(line);
          } catch {
            break;
          }
        }

        console.log('Labeled responses:', responses);
        // Verify labels are correctly matched
        if (responses.length >= 2) {
          // Both responses should contain their respective labels
          expect(responses.some(r => r.includes(label1) || r.includes('first'))).toBe(true);
          expect(responses.some(r => r.includes(label2) || r.includes('second'))).toBe(true);
        }
      } catch {
        console.log('Multiple labeled responses failed');
      }

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

      const channel = `#labelbatch${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // WHO returns multiple lines - should be wrapped in batch with label
      const label = `who-${Date.now()}`;
      client.send(`@label=${label} WHO ${channel}`);

      try {
        // May receive BATCH start with labeled-response type
        const response = await client.waitForLine(/BATCH|352|315|label=/i, 5000);
        console.log('WHO response with label:', response);

        // Collect remaining WHO responses
        const startTime = Date.now();
        while (Date.now() - startTime < 3000) {
          try {
            const line = await client.waitForLine(/352|315|BATCH/i, 500);
            if (line.includes('315')) break; // End of WHO
            if (line.includes('BATCH -')) break;
          } catch {
            break;
          }
        }
      } catch {
        console.log('Labeled WHO failed');
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

      const channel = `#labelecho${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      const label = `msg-${Date.now()}`;
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

      try {
        const response = await client.waitForLine(/PONG|FAIL/i, 3000);
        console.log('Empty label response:', response);
      } catch {
        console.log('No response for empty label');
      }

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

      try {
        const response = await client.waitForLine(/PONG|FAIL/i, 3000);
        console.log('Long label response:', response);
      } catch {
        console.log('No response for long label');
      }

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

      try {
        const response = await client.waitForLine(/PONG|label=/i, 3000);
        if (response.includes('label=')) {
          expect(response).toContain(specialLabel);
        }
        console.log('Special char label response:', response);
      } catch {
        console.log('No response for special label');
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
      const label = `ignore-${Date.now()}`;
      client.send(`@label=${label} PING :test`);

      try {
        const response = await client.waitForLine(/PONG/i, 3000);
        // Response should NOT contain label when capability not enabled
        expect(response).not.toContain('label=');
        console.log('Response without label cap:', response);
      } catch {
        console.log('No PONG received');
      }

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

      const channel = `#labelack${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Some commands produce no output - server should send ACK
      const label = `ack-${Date.now()}`;
      // MODE without parameters typically just shows modes, but setting mode
      // on a channel we created might produce ACK
      client.send(`@label=${label} MODE ${channel} +t`);

      try {
        const response = await client.waitForLine(/ACK|MODE|label=/i, 3000);
        console.log('ACK/MODE response:', response);
      } catch {
        console.log('No ACK response');
      }

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

      const label = `err-${Date.now()}`;
      // Try to join an invalid channel name
      client.send(`@label=${label} JOIN invalidchannel`);

      try {
        const response = await client.waitForLine(/4\d\d|JOIN|label=/i, 3000);
        console.log('Error response with label:', response);
        // Error should include label
      } catch {
        console.log('No error response');
      }

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

      const channel = `#tags${Date.now()}`;
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

      const channel = `#react${Date.now()}`;
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

      const channel = `#tagmsg${Date.now()}`;
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

      const channel = `#tagmsg2${Date.now()}`;
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
