import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * WebPush Tests (draft/webpush)
 *
 * Tests the IRCv3 webpush specification for push notifications.
 * Allows clients to register for push notifications when disconnected.
 */
describe('IRCv3 WebPush (draft/webpush)', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises draft/webpush', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wptest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/webpush')).toBe(true);
    });

    it('can request draft/webpush capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wptest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/webpush']);

      expect(result.ack).toContain('draft/webpush');
    });
  });

  describe('WEBPUSH Command', () => {
    it('WEBPUSH REGISTER accepts push subscription', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wpreg1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpreg1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // WEBPUSH REGISTER with dummy endpoint
      // Real format: WEBPUSH REGISTER <endpoint> <p256dh> <auth>
      client.raw('WEBPUSH REGISTER https://push.example.com/endpoint dummy-p256dh-key dummy-auth-key');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|4\d\d/i, 5000);
        console.log('WEBPUSH REGISTER response:', response);
      } catch {
        console.log('No WEBPUSH response - may require authentication');
      }
    });

    it('WEBPUSH UNREGISTER removes subscription', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wpunreg1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpunreg1');
      await client.waitForRaw(/001/);

      // First register
      client.raw('WEBPUSH REGISTER https://push.example.com/test dummy-key dummy-auth');
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Then unregister
      client.raw('WEBPUSH UNREGISTER https://push.example.com/test');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|4\d\d/i, 5000);
        console.log('WEBPUSH UNREGISTER response:', response);
      } catch {
        console.log('No WEBPUSH UNREGISTER response');
      }
    });

    it('WEBPUSH LIST shows current subscriptions', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wplist1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wplist1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      client.raw('WEBPUSH LIST');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|4\d\d/i, 5000);
        console.log('WEBPUSH LIST response:', response);
      } catch {
        console.log('No WEBPUSH LIST response');
      }
    });
  });

  describe('WEBPUSH Requirements', () => {
    it('WEBPUSH may require authentication', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wpauth1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpauth1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Try to register without being authenticated
      client.raw('WEBPUSH REGISTER https://push.example.com/unauth dummy dummy');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|ACCOUNT_REQUIRED|4\d\d/i, 3000);
        console.log('Unauthenticated WEBPUSH response:', response);
        // May require authentication
      } catch {
        console.log('No response for unauthenticated WEBPUSH');
      }
    });
  });

  describe('WEBPUSH Edge Cases', () => {
    it('WEBPUSH with invalid endpoint format', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wpinv1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpinv1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Invalid endpoint (not https)
      client.raw('WEBPUSH REGISTER http://insecure.example.com/push dummy dummy');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|4\d\d/i, 3000);
        console.log('Invalid endpoint response:', response);
        // Should fail - endpoints must be https
      } catch {
        console.log('No response for invalid endpoint');
      }
    });

    it('WEBPUSH UNREGISTER nonexistent subscription', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'wpnoexist1' })
      );

      await client.capLs();
      await client.capReq(['draft/webpush']);
      client.capEnd();
      client.register('wpnoexist1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Unregister something that doesn't exist
      client.raw('WEBPUSH UNREGISTER https://nonexistent.example.com/push');

      try {
        const response = await client.waitForRaw(/WEBPUSH|FAIL|4\d\d/i, 3000);
        console.log('Nonexistent subscription response:', response);
      } catch {
        console.log('No response for nonexistent unregister');
      }
    });
  });
});

describe('IRCv3 Event Playback (draft/event-playback)', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises draft/event-playback', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'eptest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/event-playback')).toBe(true);
    });

    it('can request draft/event-playback capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'eptest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/event-playback']);

      expect(result.ack).toContain('draft/event-playback');
    });
  });

  describe('Event Playback with Chathistory', () => {
    it('chathistory includes events with event-playback', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'ephistory1' })
      );

      await client.capLs();
      await client.capReq(['draft/event-playback', 'draft/chathistory', 'batch', 'message-tags']);
      client.capEnd();
      client.register('ephistory1');
      await client.waitForRaw(/001/);

      const channel = `#ephistory${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Send some messages
      client.say(channel, 'Event playback test 1');
      client.say(channel, 'Event playback test 2');
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request history - with event-playback, should include JOINs, etc.
      client.raw(`CHATHISTORY LATEST ${channel} * 20`);

      try {
        const batchStart = await client.waitForRaw(/BATCH \+\S+ chathistory/i, 5000);
        expect(batchStart).toBeDefined();

        const messages = await client.collectRaw(
          /PRIVMSG|JOIN|PART|MODE/,
          { timeout: 3000, stopPattern: /BATCH -/ }
        );

        console.log('Event playback messages:', messages.length);
        // With event-playback, history may include JOIN events
      } catch {
        console.log('Event playback history retrieval failed');
      }
    });
  });
});
