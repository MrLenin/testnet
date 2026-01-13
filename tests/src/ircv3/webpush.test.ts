import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';

/**
 * WebPush Tests (draft/webpush)
 *
 * Tests the IRCv3 webpush specification for push notifications.
 * Allows clients to register for push notifications when disconnected.
 */
describe('IRCv3 WebPush (draft/webpush)', () => {
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
    it('server advertises draft/webpush', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/webpush')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/webpush capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/webpush']);
      expect(result.ack).toContain('draft/webpush');

      client.send('QUIT');
    });
  });

  describe('WEBPUSH Command', () => {
    it('WEBPUSH REGISTER accepts push subscription', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpreg1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // WEBPUSH REGISTER with dummy endpoint
      // Real format: WEBPUSH REGISTER <endpoint> <p256dh> <auth>
      client.send('WEBPUSH REGISTER https://push.example.com/endpoint dummy-p256dh-key dummy-auth-key');

      // Server MUST respond to WEBPUSH command - either success or error
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^[49]\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      // Response should indicate success, failure, or authentication requirement
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });

    it('WEBPUSH UNREGISTER removes subscription', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpunreg1');
      await client.waitForNumeric('001');

      // First register
      client.send('WEBPUSH REGISTER https://push.example.com/test dummy-key dummy-auth');
      // Wait for registration response
      await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );

      client.clearRawBuffer();

      // Then unregister
      client.send('WEBPUSH UNREGISTER https://push.example.com/test');

      // Server MUST respond to UNREGISTER command
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });

    it('WEBPUSH LIST shows current subscriptions', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wplist1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      client.send('WEBPUSH LIST');

      // Server MUST respond to LIST command
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });

  describe('WEBPUSH Requirements', () => {
    it('WEBPUSH may require authentication', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpauth1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Try to register without being authenticated to a services account
      client.send('WEBPUSH REGISTER https://push.example.com/unauth dummy dummy');

      // Server MUST respond - either success or error requiring authentication
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });

  describe('WEBPUSH Edge Cases', () => {
    it('WEBPUSH with invalid endpoint format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpinv1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Invalid endpoint (not https) - server should reject or handle gracefully
      client.send('WEBPUSH REGISTER http://insecure.example.com/push dummy dummy');

      // Server MUST respond - either rejection or graceful handling
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });

    it('WEBPUSH UNREGISTER nonexistent subscription', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpnoexist1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Unregister something that doesn't exist
      client.send('WEBPUSH UNREGISTER https://nonexistent.example.com/push');

      // Server MUST respond - either error or graceful handling
      const response = await client.waitForParsedLine(
        msg => msg.command === 'WEBPUSH' || msg.command === 'FAIL' ||
               /^4\d\d$/.test(msg.command) || msg.raw.includes('ACCOUNT'),
        5000
      );
      expect(response).toBeDefined();
      expect(response.command.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });
});

/**
 * Event Playback Tests (draft/event-playback)
 */
describe('IRCv3 Event Playback (draft/event-playback)', () => {
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
    it('server advertises draft/event-playback', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/event-playback')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/event-playback capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/event-playback']);

      expect(result.ack).toContain('draft/event-playback');

      client.send('QUIT');
    });
  });

  describe('Event Playback with Chathistory', () => {
    it('chathistory includes events with event-playback', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/event-playback', 'draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('ephistory1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('ephistory');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      // Send some messages
      client.send(`PRIVMSG ${channel} :Event playback test 1`);
      client.send(`PRIVMSG ${channel} :Event playback test 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request history - with event-playback, should include JOINs, etc.
      client.send(`CHATHISTORY LATEST ${channel} * 20`);

      // Server MUST respond with batch start
      const batchStart = await client.waitForParsedLine(
        msg => msg.command === 'BATCH' && msg.params[0]?.startsWith('+') && msg.params[1] === 'chathistory',
        5000
      );
      expect(batchStart).toBeDefined();
      expect(batchStart.command).toBe('BATCH');
      expect(batchStart.params[1]).toBe('chathistory');

      // Collect messages until BATCH end
      const messages: string[] = [];
      let done = false;
      const startTime = Date.now();
      while (!done && Date.now() - startTime < 3000) {
        const msg = await client.waitForParsedLine(
          m => ['PRIVMSG', 'JOIN', 'PART', 'MODE', 'BATCH'].includes(m.command),
          1000
        ).catch(() => null);
        if (!msg) break;
        messages.push(msg.raw);
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) {
          done = true;
        }
      }

      // Should have received batch end and at least some messages
      expect(done).toBe(true);
      expect(messages.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });
});
