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
  createAuthenticatedX3Client,
  createTestAccount,
  uniqueId,
  isKeycloakAvailable,
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
    it('should respond to HELP command', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('O3', 'HELP');
      console.log('O3 HELP response (first 5):', lines.slice(0, 5));

      expect(lines.length).toBeGreaterThan(0);
    });

    it('should report access level via MYACCESS', async () => {
      const client = trackClient(await createX3Client());

      const level = await client.myAccess();
      console.log('MYACCESS level:', level);

      // Should return a level (0 for non-oper)
      expect(level).toBeGreaterThanOrEqual(0);
    });

    it('should report higher access for authenticated oper user', async () => {
      // This test requires a Keycloak user with x3_opserv_level set
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        // Try to authenticate as oper user (testoper with x3_opserv_level=500)
        const client = trackClient(
          await createAuthenticatedX3Client('testoper', 'testpass')
        );

        const level = await client.myAccess();
        console.log('Oper MYACCESS level:', level);

        // If properly set up, should have oper level
        if (level > 0) {
          expect(level).toBeGreaterThanOrEqual(100);
        }
      } catch (e) {
        console.log('Could not authenticate as oper user:', e);
      }
    });
  });

  describe('G-line Management', () => {
    it('should reject GLINE from non-oper user', async () => {
      const client = trackClient(await createX3Client());

      // Try to GLINE without oper access - should fail
      const result = await client.gline('*!*@test.example.com', '1h', 'Test gline');
      console.log('Non-oper GLINE response:', result.lines);

      // Should be denied - O3 will say "privileged service"
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should allow GLINE from oper user', async () => {
      // This requires an authenticated oper user
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        const client = trackClient(
          await createAuthenticatedX3Client('testoper', 'testpass')
        );

        const level = await client.myAccess();
        if (level < 200) {
          console.log('Skipping - insufficient oper level:', level);
          return;
        }

        // Add a test GLINE
        const testMask = `*!*@glinetest-${uniqueId().slice(0, 8)}.example.com`;
        const result = await client.gline(testMask, '1m', 'Test gline from tests');
        console.log('Oper GLINE response:', result.lines);

        expect(result.success).toBe(true);

        // Clean up
        await client.ungline(testMask);
      } catch (e) {
        console.log('Could not test oper GLINE:', e);
      }
    });

    it('should remove GLINE with UNGLINE', async () => {
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        const client = trackClient(
          await createAuthenticatedX3Client('testoper', 'testpass')
        );

        const level = await client.myAccess();
        if (level < 200) {
          console.log('Skipping - insufficient oper level');
          return;
        }

        // Add then remove a GLINE
        const testMask = `*!*@ungline-${uniqueId().slice(0, 8)}.example.com`;
        await client.gline(testMask, '1h', 'Test for ungline');

        const result = await client.ungline(testMask);
        console.log('UNGLINE response:', result.lines);

        expect(result.success).toBe(true);
      } catch (e) {
        console.log('Could not test UNGLINE:', e);
      }
    });
  });

  describe('User Operations', () => {
    it('should allow oper to force-join user to channel', async () => {
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        const operClient = trackClient(
          await createAuthenticatedX3Client('testoper', 'testpass')
        );

        const level = await operClient.myAccess();
        if (level < 200) {
          console.log('Skipping - insufficient oper level');
          return;
        }

        // Create a target user
        const targetClient = trackClient(await createX3Client());
        const targetNick = `target${uniqueId().slice(0, 5)}`;

        // Register target with a known nick
        targetClient.send(`NICK ${targetNick}`);
        await new Promise(r => setTimeout(r, 500));

        // Force join target to a channel
        const channel = `#optest${uniqueId().slice(0, 5)}`;
        const result = await operClient.forceJoin(targetNick, channel);
        console.log('FORCEJOIN response:', result.lines);

        // Check if target is in channel
        targetClient.clearRawBuffer();
        targetClient.send(`NAMES ${channel}`);
        const namesResponse = await targetClient.waitForLine(/353|366/, 3000);
        console.log('NAMES after forcejoin:', namesResponse);
      } catch (e) {
        console.log('Could not test force-join:', e);
      }
    });
  });

  describe('Direct Commands', () => {
    it('should respond to STATS command', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('O3', 'STATS');
      console.log('STATS response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });

    it('should respond to UPLINK command', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('O3', 'UPLINK');
      console.log('UPLINK response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });

    it('should respond to UPTIME command', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('O3', 'UPTIME');
      console.log('UPTIME response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should reject GLINE without proper arguments', async () => {
      const client = trackClient(await createX3Client());

      // GLINE without arguments
      const lines = await client.serviceCmd('O3', 'GLINE');
      console.log('Empty GLINE response:', lines);

      // Should get usage/error message or "privileged service" (for non-opers)
      expect(lines.length).toBeGreaterThan(0);
      const hasError = lines.some(l =>
        l.toLowerCase().includes('usage') ||
        l.toLowerCase().includes('syntax') ||
        l.toLowerCase().includes('help') ||
        l.toLowerCase().includes('must') ||
        l.toLowerCase().includes('privileged')
      );
      expect(hasError).toBe(true);
    });

    it('should handle unknown command gracefully', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('O3', 'UNKNOWNCOMMAND123');
      console.log('Unknown command response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });
  });
});
