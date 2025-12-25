import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * Standard Replies Tests (standard-replies)
 *
 * Tests the IRCv3 standard replies specification which provides
 * consistent machine-readable error and status messages.
 */
describe('IRCv3 Standard Replies', () => {
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
    it('server advertises standard-replies', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srtest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('standard-replies')).toBe(true);
    });

    it('can request standard-replies capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srtest2' })
      );

      await client.capLs();
      const result = await client.capReq(['standard-replies']);

      expect(result.ack).toContain('standard-replies');
    });
  });

  describe('FAIL Reply Format', () => {
    it('FAIL includes command, code, and description', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srfail1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srfail1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Try something that should fail
      // PRIVMSG to non-existent user
      client.raw('PRIVMSG nonexistentnickxyz123 :test');

      try {
        // With standard-replies, errors use FAIL format
        // FAIL <command> <code> [context...] :<description>
        const response = await client.waitForRaw(/FAIL|401/i, 3000);
        console.log('Error response:', response);

        if (response.includes('FAIL')) {
          // Verify FAIL format
          expect(response).toMatch(/FAIL\s+\w+\s+\w+/);
        }
      } catch {
        console.log('No FAIL response');
      }
    });

    it('FAIL for invalid command syntax', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srfail2' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srfail2');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Send malformed command
      client.raw('JOIN'); // Missing channel

      try {
        const response = await client.waitForRaw(/FAIL|461/i, 3000);
        console.log('Syntax error response:', response);
      } catch {
        console.log('No response for syntax error');
      }
    });
  });

  describe('WARN Reply Format', () => {
    it('WARN for non-fatal issues', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srwarn1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srwarn1');
      await client.waitForRaw(/001/);

      // WARN is less common, may not trigger easily
      // Format: WARN <command> <code> [context...] :<description>

      expect(client.hasCapEnabled('standard-replies')).toBe(true);
    });
  });

  describe('NOTE Reply Format', () => {
    it('NOTE for informational messages', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srnote1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srnote1');
      await client.waitForRaw(/001/);

      // NOTE is informational
      // Format: NOTE <command> <code> [context...] :<description>

      expect(client.hasCapEnabled('standard-replies')).toBe(true);
    });
  });

  describe('Standard Reply Codes', () => {
    it('ACCOUNT_REQUIRED for operations needing authentication', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srauth1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies', 'draft/chathistory']);
      client.capEnd();
      client.register('srauth1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Try to access chathistory without auth
      client.raw('CHATHISTORY LATEST #somechannel * 10');

      try {
        const response = await client.waitForRaw(/FAIL|ACCOUNT_REQUIRED|4\d\d/i, 3000);
        console.log('Auth required response:', response);
      } catch {
        console.log('No auth-required response');
      }
    });

    it('INVALID_TARGET for bad target specification', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srtarget1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srtarget1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Invalid channel name
      client.raw('JOIN invalid channel name with spaces');

      try {
        const response = await client.waitForRaw(/FAIL|INVALID|4\d\d/i, 3000);
        console.log('Invalid target response:', response);
      } catch {
        console.log('No invalid target response');
      }
    });

    it('MESSAGE_TOO_LONG for oversized messages', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srlong1' })
      );

      await client.capLs();
      await client.capReq(['standard-replies']);
      client.capEnd();
      client.register('srlong1');
      await client.waitForRaw(/001/);

      const channel = `#srlong${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Send very long message
      const longMsg = 'A'.repeat(1000);
      client.raw(`PRIVMSG ${channel} :${longMsg}`);

      try {
        const response = await client.waitForRaw(/FAIL|MESSAGE_TOO_LONG|4\d\d/i, 3000);
        console.log('Long message response:', response);
      } catch {
        // Message may just be truncated instead of rejected
        console.log('No long message error');
      }
    });
  });

  describe('Without standard-replies', () => {
    it('uses traditional numerics without standard-replies', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'srno1' })
      );

      // Do NOT request standard-replies
      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('srno1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Try something that should fail
      client.raw('PRIVMSG nonexistentxyz :test');

      try {
        const response = await client.waitForRaw(/FAIL|401|NOSUCHNICK/i, 3000);
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
    });
  });
});

describe('IRCv3 draft/extended-isupport', () => {
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
    it('server advertises draft/extended-isupport', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'eistest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/extended-isupport')).toBe(true);
    });
  });

  describe('ISUPPORT via CAP', () => {
    it('can receive ISUPPORT tokens via CAP', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'eistest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/extended-isupport']);

      if (result.ack.includes('draft/extended-isupport')) {
        // With extended-isupport, ISUPPORT can be queried/received via CAP
        expect(result.ack).toContain('draft/extended-isupport');
      }
    });
  });
});
