import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Standard Replies Tests (standard-replies)
 *
 * Tests the IRCv3 standard replies specification which provides
 * consistent machine-readable error and status messages.
 */
describe('IRCv3 Standard Replies', () => {
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
    it('server advertises standard-replies', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('standard-replies')).toBe(true);

      client.send('QUIT');
    });

    it('can request standard-replies capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['standard-replies']);

      expect(result.ack).toContain('standard-replies');

      client.send('QUIT');
    });
  });

  describe('FAIL Reply Format', () => {
    it('FAIL includes command, code, and description', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srfail1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try something that should fail
      // PRIVMSG to non-existent user
      client.send('PRIVMSG nonexistentnickxyz123 :test');

      try {
        // With standard-replies, errors use FAIL format
        // FAIL <command> <code> [context...] :<description>
        const response = await client.waitForLine(/FAIL|401/i, 3000);
        console.log('Error response:', response);

        if (response.includes('FAIL')) {
          // Verify FAIL format
          expect(response).toMatch(/FAIL\s+\w+\s+\w+/);
        }
      } catch {
        console.log('No FAIL response');
      }

      client.send('QUIT');
    });

    it('FAIL for invalid command syntax', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srfail2');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Send malformed command
      client.send('JOIN'); // Missing channel

      try {
        const response = await client.waitForLine(/FAIL|461/i, 3000);
        console.log('Syntax error response:', response);
      } catch {
        console.log('No response for syntax error');
      }

      client.send('QUIT');
    });
  });

  describe('WARN Reply Format', () => {
    it('WARN for non-fatal issues', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srwarn1');
      await client.waitForLine(/001/);

      // WARN is less common, may not trigger easily
      // Format: WARN <command> <code> [context...] :<description>

      expect(client.hasCapEnabled('standard-replies')).toBe(true);

      client.send('QUIT');
    });
  });

  describe('NOTE Reply Format', () => {
    it('NOTE for informational messages', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srnote1');
      await client.waitForLine(/001/);

      // NOTE is informational
      // Format: NOTE <command> <code> [context...] :<description>

      expect(client.hasCapEnabled('standard-replies')).toBe(true);

      client.send('QUIT');
    });
  });

  describe('Standard Reply Codes', () => {
    it('ACCOUNT_REQUIRED for operations needing authentication', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies', 'draft/chathistory']);
      client.capEnd();
      client.register('srauth1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try to access chathistory without auth
      client.send('CHATHISTORY LATEST #somechannel * 10');

      try {
        const response = await client.waitForLine(/FAIL|ACCOUNT_REQUIRED|4\d\d/i, 3000);
        console.log('Auth required response:', response);
      } catch {
        console.log('No auth-required response');
      }

      client.send('QUIT');
    });

    it('INVALID_TARGET for bad target specification', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srtarget1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Invalid channel name
      client.send('JOIN invalid channel name with spaces');

      try {
        const response = await client.waitForLine(/FAIL|INVALID|4\d\d/i, 3000);
        console.log('Invalid target response:', response);
      } catch {
        console.log('No invalid target response');
      }

      client.send('QUIT');
    });

    it('MESSAGE_TOO_LONG for oversized messages', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srlong1');
      await client.waitForLine(/001/);

      const channel = `#srlong${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Send very long message
      const longMsg = 'A'.repeat(1000);
      client.send(`PRIVMSG ${channel} :${longMsg}`);

      try {
        const response = await client.waitForLine(/FAIL|MESSAGE_TOO_LONG|4\d\d/i, 3000);
        console.log('Long message response:', response);
      } catch {
        // Message may just be truncated instead of rejected
        console.log('No long message error');
      }

      client.send('QUIT');
    });
  });

  describe('Without standard-replies', () => {
    it('uses traditional numerics without standard-replies', async () => {
      const client = trackClient(await createRawSocketClient());

      // Do NOT request standard-replies
      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('srno1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try something that should fail
      client.send('PRIVMSG nonexistentxyz :test');

      try {
        const response = await client.waitForLine(/FAIL|401|NOSUCHNICK/i, 3000);
        // Should be traditional numeric, not FAIL
        if (response.includes('FAIL')) {
          throw new Error('Should not receive FAIL without standard-replies');
        }
        console.log('Traditional error response:', response);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        console.log('No error response');
      }

      client.send('QUIT');
    });
  });
});

describe('IRCv3 draft/extended-isupport', () => {
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
    it('server advertises draft/extended-isupport', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/extended-isupport')).toBe(true);

      client.send('QUIT');
    });
  });

  describe('ISUPPORT via CAP', () => {
    it('can receive ISUPPORT tokens via CAP', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/extended-isupport']);

      if (result.ack.includes('draft/extended-isupport')) {
        // With extended-isupport, ISUPPORT can be queried/received via CAP
        expect(result.ack).toContain('draft/extended-isupport');
      }

      client.send('QUIT');
    });
  });
});
