/**
 * OpServ (O3) Tests
 *
 * Tests X3 OpServ functionality:
 * - G-line management (network-wide bans)
 * - User operations (KILL, TRACE)
 * - Access verification (MYACCESS)
 * - DEFCON levels
 *
 * OpServ Communication:
 *   Client → O3:  PRIVMSG O3 :<command>
 *   O3 → Client:  NOTICE <nick> :<response>
 *
 * NOTE: OpServ commands require oper-level access.
 * This is granted via x3_opserv_level attribute in Keycloak.
 *
 * Oper levels:
 *   0-99:   No oper access
 *   100-199: Helper - limited commands
 *   200-399: Oper - most commands
 *   400-599: Admin - advanced commands
 *   600-899: Network Admin
 *   900-999: Support
 *   1000:    Root - full access
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  X3Client,
  createX3Client,
  createOperClient,
  uniqueId,
  assertServiceSuccess,
  assertServiceError,
} from '../helpers/index.js';

describe('OpServ (O3)', () => {
  const clients: X3Client[] = [];

  const trackClient = (client: X3Client): X3Client => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.send('QUIT');
        client.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    clients.length = 0;
  });

  describe('Basic Access', () => {
    it('should respond to HELP command', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());

      // O3 responds to HELP even for non-opers (with "privileged service" message)
      const lines = await client.serviceCmd('O3', 'HELP');
      console.log('O3 HELP response (first 5):', lines.slice(0, 5));

      expect(lines.length, 'Expected HELP response').toBeGreaterThan(0);
      // Should contain O3/OpServ reference or command list
      expect(lines.some(l => /O3|OpServ|command|HELP/i.test(l))).toBe(true);
    });

    it('should report access level via MYACCESS', async () => {
      const client = trackClient(await createX3Client());

      const level = await client.myAccess();
      console.log('MYACCESS level:', level);

      // Should return a level (0 for non-oper)
      expect(level).toBeGreaterThanOrEqual(0);
    });

    it('should report higher access for authenticated oper user', async () => {
      // Use createOperClient which auths with X3_ADMIN (olevel 1000)
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const level = await client.myAccess();
      console.log('Oper MYACCESS level:', level);

      // X3_ADMIN (first oper to register) should have olevel 1000
      expect(level).toBe(1000);
    });
  });

  describe('G-line Management', () => {
    it('should reject GLINE from non-oper user', async () => {
      const client = trackClient(await createX3Client());

      // Try to GLINE without oper access - should fail
      const result = await client.gline('*@test.example.com', '1h', 'Test gline');
      console.log('Non-oper GLINE response:', result.lines);

      // Should be denied - O3 will say "privileged service"
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should allow GLINE from oper user', { retry: 2 }, async () => {
      // Use createOperClient which auths with X3_ADMIN (olevel 1000)
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const level = await client.myAccess();
      console.log('Oper level:', level);
      expect(level).toBe(1000);

      // Add a test GLINE (format: user@host, not nick!user@host)
      const testMask = `*@glinetest-${uniqueId().slice(0, 8)}.example.com`;
      const result = await client.gline(testMask, '1m', 'Test gline from tests');
      console.log('Oper GLINE response:', result.lines);

      expect(result.success).toBe(true);

      // Clean up
      await client.ungline(testMask);
    });

    it('should remove GLINE with UNGLINE', { retry: 2 }, async () => {
      // Use createOperClient which auths with X3_ADMIN (olevel 1000)
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const level = await client.myAccess();
      console.log('Oper level:', level);
      expect(level).toBe(1000);

      // Add then remove a GLINE (format: user@host, not nick!user@host)
      const testMask = `*@ungline-${uniqueId().slice(0, 8)}.example.com`;
      const glineResult = await client.gline(testMask, '1h', 'Test for ungline');
      console.log('GLINE response:', glineResult.lines);
      expect(glineResult.success).toBe(true);

      // Wait for gline to propagate (longer delay to ensure server has processed it)
      await new Promise(r => setTimeout(r, 500));

      // Clear buffer before UNGLINE to avoid consuming stale messages
      client.clearRawBuffer();

      const result = await client.ungline(testMask);
      console.log('UNGLINE response:', result.lines);

      // UNGLINE should return response like "G-line removed for X" or "Unknown/expired G-line removed for X"
      expect(result.success).toBe(true);
    });
  });

  describe('User Operations', () => {
    it('should allow oper to force-join user to channel', async () => {
      // Use createOperClient which auths with X3_ADMIN (olevel 1000)
      // createOperClient now verifies oper level before returning
      const operClient = trackClient(await createOperClient());

      const level = await operClient.myAccess();
      console.log('Oper level:', level);
      expect(level).toBe(1000);

      // Create a target user
      const targetClient = trackClient(await createX3Client());
      const targetNick = `target${uniqueId().slice(0, 5)}`;

      // Change nick and wait for confirmation
      targetClient.send(`NICK ${targetNick}`);
      await targetClient.waitForCommand('NICK', 3000);

      // Wait for nick change to propagate (important for O3 to see the new nick)
      await new Promise(r => setTimeout(r, 300));

      // Force join target to a channel
      // Use retry logic since X3 can be blocked on Keycloak sync operations
      const channel = `#optest${uniqueId().slice(0, 5)}`;
      let result: { lines: string[]; success: boolean; error?: string } = { lines: [], success: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await operClient.forceJoin(targetNick, channel);
        console.log(`SVSJOIN attempt ${attempt + 1}:`, result.lines);
        if (result.lines.length > 0) break;
        console.log(`[SVSJOIN attempt ${attempt + 1}] No response, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
      }

      expect(result.success).toBe(true);

      // Use retry logic for NAMES verification - SVSJOIN is async
      let foundInChannel = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 300));
        targetClient.clearRawBuffer();
        targetClient.send(`NAMES ${channel}`);
        try {
          const namesResponse = await targetClient.waitForNumeric('353', 2000);
          console.log(`NAMES attempt ${attempt + 1}:`, namesResponse.raw);
          // NAMES 353 has nick list in trailing parameter
          const nickList = namesResponse.trailing || namesResponse.params[namesResponse.params.length - 1] || '';
          if (nickList.toLowerCase().includes(targetNick.toLowerCase())) {
            foundInChannel = true;
            break;
          }
        } catch {
          console.log(`NAMES attempt ${attempt + 1}: no response`);
        }
      }

      expect(foundInChannel).toBe(true);
    });
  });

  describe('Direct Commands', () => {
    it('should respond to STATS command', async () => {
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const lines = await client.serviceCmd('O3', 'STATS');
      console.log('STATS response:', lines);

      expect(lines.length, 'Expected STATS response').toBeGreaterThan(0);
      // Should get actual stats, not "privileged service"
      expect(lines.some(l => l.includes('privileged')), 'Should not get privileged error').toBe(false);
      // Should contain stats-related content
      expect(lines.some(l => /stat|uptime|user|channel|server/i.test(l)), 'Should contain stats content').toBe(true);
    });

    it('should respond to STATS UPLINK command', async () => {
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const lines = await client.serviceCmd('O3', 'STATS UPLINK');
      console.log('STATS UPLINK response:', lines);

      expect(lines.length, 'Expected STATS UPLINK response').toBeGreaterThan(0);
      expect(lines.some(l => l.includes('privileged')), 'Should not get privileged error').toBe(false);
      // Should contain uplink/server connection info
      expect(lines.some(l => /uplink|server|link|connect/i.test(l)), 'Should contain uplink info').toBe(true);
    });

    it('should respond to STATS UPTIME command', async () => {
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const lines = await client.serviceCmd('O3', 'STATS UPTIME');
      console.log('STATS UPTIME response:', lines);

      expect(lines.length, 'Expected STATS UPTIME response').toBeGreaterThan(0);
      expect(lines.some(l => l.includes('privileged')), 'Should not get privileged error').toBe(false);
      // Should contain uptime info (time units)
      expect(lines.some(l => /uptime|day|hour|minute|second/i.test(l)), 'Should contain uptime info').toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should reject GLINE without proper arguments', async () => {
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      // GLINE without arguments - should get usage error
      const lines = await client.serviceCmd('O3', 'GLINE');
      console.log('Empty GLINE response:', lines);

      expect(lines.length, 'Expected GLINE usage response').toBeGreaterThan(0);
      // Should NOT get "privileged service" since we're an oper
      expect(lines.some(l => l.includes('privileged')), 'Should not get privileged error').toBe(false);
      // Should get usage/syntax error
      const hasUsageError = lines.some(l =>
        l.toLowerCase().includes('usage') ||
        l.toLowerCase().includes('syntax') ||
        l.toLowerCase().includes('help') ||
        l.toLowerCase().includes('must') ||
        l.toLowerCase().includes('missing') ||
        l.toLowerCase().includes('requires')
      );
      expect(hasUsageError, 'Should get usage/syntax error for GLINE without args').toBe(true);
    });

    it('should handle unknown command gracefully', async () => {
      // createOperClient now verifies oper level before returning
      const client = trackClient(await createOperClient());

      const lines = await client.serviceCmd('O3', 'UNKNOWNCOMMAND123');
      console.log('Unknown command response:', lines);

      expect(lines.length, 'Expected unknown command response').toBeGreaterThan(0);
      // Should NOT get "privileged service" since we're an oper
      expect(lines.some(l => l.includes('privileged')), 'Should not get privileged error').toBe(false);
      // Should get "unknown command" or similar error
      const hasUnknownError = lines.some(l =>
        l.toLowerCase().includes('unknown') ||
        l.toLowerCase().includes('invalid') ||
        l.toLowerCase().includes('unrecognized')
      );
      expect(hasUnknownError, 'Should get unknown/invalid command error').toBe(true);
    });
  });
});
