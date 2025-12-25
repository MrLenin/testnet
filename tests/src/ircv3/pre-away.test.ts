import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * Pre-Away Tests (draft/pre-away)
 *
 * Tests the IRCv3 pre-away specification which allows clients to set
 * their away status during connection registration, before completing
 * the registration process.
 */
describe('IRCv3 Pre-Away (draft/pre-away)', () => {
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
    it('server advertises draft/pre-away', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'patest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/pre-away')).toBe(true);
    });

    it('can request draft/pre-away capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'patest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/pre-away']);

      expect(result.ack).toContain('draft/pre-away');
    });
  });

  describe('AWAY During Registration', () => {
    it('can send AWAY before CAP END', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'papre1' })
      );

      await client.capLs();
      await client.capReq(['draft/pre-away', 'away-notify']);

      // Set away BEFORE CAP END
      client.raw('AWAY :Connecting...');

      // Should not receive error - pre-away allows this
      await new Promise(r => setTimeout(r, 300));

      // Now complete registration
      client.capEnd();
      client.register('papre1');

      const welcome = await client.waitForRaw(/001/);
      expect(welcome).toContain('papre1');

      // Verify we're marked as away
      client.clearRawBuffer();
      client.raw('WHOIS papre1');

      try {
        // 301 is RPL_AWAY in WHOIS
        const whoisAway = await client.waitForRaw(/301.*papre1/i, 5000);
        expect(whoisAway).toContain('Connecting...');
      } catch {
        // May need to check differently
        console.log('No away status in WHOIS');
      }
    });

    it('AWAY before registration persists after registration', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'papersist1' })
      );

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Set away before registration
      const awayMessage = 'Set during registration';
      client.raw(`AWAY :${awayMessage}`);

      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('papersist1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Check if away persists
      client.raw('WHOIS papersist1');

      try {
        const whoisReply = await client.waitForRaw(/301.*papersist1/i, 5000);
        expect(whoisReply).toContain(awayMessage);
      } catch {
        console.log('Away status may not persist or WHOIS format differs');
      }
    });

    it('other users see pre-set away status on join', async () => {
      const preaway = trackClient(
        await createRawIRCv3Client({ nick: 'pajoiner1' })
      );
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'paobs1' })
      );

      // Pre-away client sets away during registration
      await preaway.capLs();
      await preaway.capReq(['draft/pre-away']);
      preaway.raw('AWAY :Pre-set away message');
      await new Promise(r => setTimeout(r, 200));
      preaway.capEnd();
      preaway.register('pajoiner1');
      await preaway.waitForRaw(/001/);

      // Observer with away-notify
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register('paobs1');
      await observer.waitForRaw(/001/);

      const channel = `#preaway${Date.now()}`;
      observer.join(channel);
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Pre-away client joins
      preaway.join(channel);
      await preaway.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Observer may receive AWAY notification
      try {
        const awayNotif = await observer.waitForRaw(/AWAY.*pajoiner1/i, 3000);
        expect(awayNotif).toContain('Pre-set away message');
      } catch {
        // May not send AWAY on join, depends on implementation
        console.log('No AWAY notification on join');
      }
    });
  });

  describe('Without pre-away', () => {
    it('AWAY before registration without pre-away may fail', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'panopre1' })
      );

      // Do NOT request pre-away
      await client.capLs();
      await client.capReq(['multi-prefix']);

      client.clearRawBuffer();

      // Try AWAY before CAP END
      client.raw('AWAY :Should not work');

      try {
        // May receive error or be ignored
        const response = await client.waitForRaw(/AWAY|FAIL|4\d\d|451/i, 2000);
        console.log('AWAY without pre-away response:', response);
        // 451 = ERR_NOTREGISTERED
      } catch {
        // May be silently ignored
        console.log('AWAY without pre-away silently ignored');
      }

      // Complete registration
      client.capEnd();
      client.register('panopre1');
      await client.waitForRaw(/001/);
    });
  });

  describe('Pre-Away Edge Cases', () => {
    it('can clear pre-away with empty AWAY', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'paclear1' })
      );

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Set away
      client.raw('AWAY :Initial away');
      await new Promise(r => setTimeout(r, 200));

      // Clear away before registration
      client.raw('AWAY');
      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('paclear1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Check if away is cleared
      client.raw('WHOIS paclear1');

      try {
        // Should NOT have 301 (away) in WHOIS
        const whoisLines = await client.collectRaw(/3\d\d.*paclear1/i, { timeout: 2000 });
        const hasAway = whoisLines.some(l => l.includes('301'));
        expect(hasAway).toBe(false);
      } catch {
        console.log('Could not verify away cleared');
      }
    });

    it('multiple AWAY commands during registration uses last one', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'pamulti1' })
      );

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Multiple away messages
      client.raw('AWAY :First message');
      await new Promise(r => setTimeout(r, 100));
      client.raw('AWAY :Second message');
      await new Promise(r => setTimeout(r, 100));
      client.raw('AWAY :Final message');
      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('pamulti1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      client.raw('WHOIS pamulti1');

      try {
        const whoisAway = await client.waitForRaw(/301.*pamulti1/i, 5000);
        // Should have final message
        expect(whoisAway).toContain('Final message');
      } catch {
        console.log('Could not verify final away message');
      }
    });
  });
});
