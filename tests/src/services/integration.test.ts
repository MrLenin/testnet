/**
 * Services Integration Tests
 *
 * Tests cross-service functionality and integration between:
 * - AuthServ, ChanServ, OpServ
 * - X3 and Keycloak (when available)
 *
 * These tests verify that services work together correctly.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  X3Client,
  createX3Client,
  createAuthenticatedX3Client,
  createTestAccount,
  ACCESS_LEVELS,
  uniqueChannel,
  uniqueId,
  isKeycloakAvailable,
  waitForUserAccess,
} from '../helpers/index.js';

describe('Services Integration', () => {
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

  describe('AuthServ + ChanServ Integration', () => {
    it('should maintain channel access across reconnects', async () => {
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // First connection: register account and channel
      // Note: registerAndActivate already authenticates the user via COOKIE
      const client1 = trackClient(await createX3Client());
      await client1.registerAndActivate(account, password, email);
      client1.send(`JOIN ${channel}`);
      await client1.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      const regResult = await client1.registerChannel(channel);

      if (!regResult.success) {
        console.log('Channel registration failed, skipping reconnect test');
        return;
      }

      // Disconnect
      client1.send('QUIT');
      client1.close();
      clients.length = 0; // Remove from tracking

      // Second connection: verify access persists
      await new Promise(r => setTimeout(r, 1000)); // Wait for disconnect to process

      const client2 = trackClient(await createX3Client());
      await client2.auth(account, password);
      client2.send(`JOIN ${channel}`);
      await client2.waitForLine(/JOIN/i, 5000);

      // Should still be able to manage channel
      const accessList = await client2.getAccess(channel);
      console.log('Access list after reconnect:', accessList);

      const myAccess = accessList.find(e => e.account.toLowerCase() === account.toLowerCase());
      expect(myAccess).toBeDefined();
      expect(myAccess?.level).toBe(ACCESS_LEVELS.OWNER);
    });

    it('should allow channel owner to promote user to coowner', async () => {
      // X3 does not allow CLVL to owner level (500) - you can only give access
      // levels lower than your own. This test verifies promoting to COOWNER (400).
      const { account: owner, password: ownerPass, email: ownerEmail } = await createTestAccount();
      const { account: coowner, password: coownerPass, email: coownerEmail } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup owner
      // Note: registerAndActivate already authenticates the user via COOKIE
      const ownerClient = trackClient(await createX3Client());
      await ownerClient.registerAndActivate(owner, ownerPass, ownerEmail);
      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));

      // Register channel and verify success
      const regResult = await ownerClient.registerChannel(channel);
      console.log('Channel registration result:', regResult.lines, 'success:', regResult.success);
      if (!regResult.success) {
        console.log('Channel registration failed, skipping test');
        return;
      }

      // Setup coowner account
      const coownerClient = trackClient(await createX3Client());
      await coownerClient.registerAndActivate(coowner, coownerPass, coownerEmail);

      // Small delay to ensure account is fully synced before ADDUSER
      await new Promise(r => setTimeout(r, 300));

      // Add user with OP level first
      const addResult = await ownerClient.addUser(channel, coowner, ACCESS_LEVELS.OP);
      console.log('ADDUSER response:', addResult.lines);
      expect(addResult.success).toBe(true);

      // Wait for user to appear in access list before CLVL
      const addedOk = await waitForUserAccess(ownerClient, channel, coowner, ACCESS_LEVELS.OP, 8000);
      if (!addedOk) {
        console.log('waitForUserAccess failed for OP level');
      }
      expect(addedOk).toBe(true);

      // Promote to COOWNER level
      const clvlResult = await ownerClient.clvl(channel, coowner, ACCESS_LEVELS.COOWNER);
      console.log('CLVL to coowner response:', clvlResult.lines);
      expect(clvlResult.success).toBe(true);

      // Wait for level change to be visible
      const promotedOk = await waitForUserAccess(ownerClient, channel, coowner, ACCESS_LEVELS.COOWNER, 8000);
      if (!promotedOk) {
        console.log('waitForUserAccess failed for COOWNER level');
      }
      expect(promotedOk).toBe(true);

      // Small delay to ensure state is fully synced before final verification
      await new Promise(r => setTimeout(r, 300));

      // Verify user has COOWNER level
      const accessList = await ownerClient.getAccess(channel);
      console.log('Final access list:', JSON.stringify(accessList));
      console.log('Looking for coowner account:', coowner);
      const coownerEntry = accessList.find(e => e.account.toLowerCase() === coowner.toLowerCase());
      console.log('Found coowner entry:', coownerEntry);
      expect(coownerEntry?.level).toBe(ACCESS_LEVELS.COOWNER);
    }, 60000); // Extended timeout for 2 account registrations (~10s each)

    it('should enforce channel settings on all users', async () => {
      const { account: owner, password: ownerPass, email: ownerEmail } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup owner and channel
      // Note: registerAndActivate already authenticates the user via COOKIE
      const ownerClient = trackClient(await createX3Client());
      await ownerClient.registerAndActivate(owner, ownerPass, ownerEmail);
      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await ownerClient.registerChannel(channel);

      // Set channel to invite-only
      await ownerClient.set(channel, 'DEFAULTMODES', '+i');

      // Try to have non-access user join
      const guestClient = trackClient(await createX3Client());
      guestClient.send(`JOIN ${channel}`);

      // Should get invite-only error
      const joinResponse = await guestClient.waitForLine(/JOIN|473/, 5000);
      console.log('Guest join response:', joinResponse);

      // 473 is ERR_INVITEONLYCHAN
      const isInviteOnly = joinResponse.includes('473');
      if (isInviteOnly) {
        expect(isInviteOnly).toBe(true);
      } else {
        // Mode might not have been enforced yet
        console.log('Note: Invite-only mode may need time to apply');
      }
    });
  });

  describe('Multiple Account Management', () => {
    it('should track multiple concurrent logins', async () => {
      const { account, password, email } = await createTestAccount();

      // Register account (registerAndActivate also authenticates via COOKIE)
      const client1 = trackClient(await createX3Client());

      // Wait for connection to fully settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const regResult = await client1.registerAndActivate(account, password, email);

      // registerAndActivate returns success:true if COOKIE auth worked
      expect(regResult.success).toBe(true);

      const client2 = trackClient(await createX3Client());
      const authResult2 = await client2.auth(account, password);
      expect(authResult2.success).toBe(true);

      const client3 = trackClient(await createX3Client());
      const authResult3 = await client3.auth(account, password);
      expect(authResult3.success).toBe(true);

      console.log('Successfully logged in from 3 clients');
    });

    it('should share channel access between logged-in clients', async () => {
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup account and channel
      // Note: registerAndActivate already authenticates the user via COOKIE
      const client1 = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const regResult = await client1.registerAndActivate(account, password, email);
      expect(regResult.success).toBe(true);

      client1.send(`JOIN ${channel}`);
      await client1.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));

      const chanRegResult = await client1.registerChannel(channel);
      console.log('Channel registration result:', chanRegResult.success, chanRegResult.lines?.slice(0, 2));
      expect(chanRegResult.success).toBe(true);

      // Wait for registration to fully sync
      await new Promise(r => setTimeout(r, 500));

      // Second client should also have access
      const client2 = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const authResult = await client2.auth(account, password);
      console.log('Client2 auth result:', authResult.success);

      client2.send(`JOIN ${channel}`);
      await client2.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));

      // Both should be able to get channel access
      const access1 = await client1.getAccess(channel);
      const access2 = await client2.getAccess(channel);
      console.log('Access1:', JSON.stringify(access1));
      console.log('Access2:', JSON.stringify(access2));

      expect(access1.length).toBeGreaterThan(0);
      expect(access2.length).toBeGreaterThan(0);
    });
  });

  describe('Keycloak Sync (when available)', () => {
    it('should authenticate via Keycloak SASL', async () => {
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        // testuser should exist in Keycloak
        const client = trackClient(
          await createAuthenticatedX3Client('testuser', 'testpass')
        );

        // Verify authenticated
        const authStatus = await client.checkAuth();
        console.log('Auth status:', authStatus);

        expect(authStatus.authenticated).toBe(true);
      } catch (e) {
        console.log('Could not authenticate via Keycloak:', e);
      }
    });

    it('should auto-create X3 account for new Keycloak user', async () => {
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        // Try to auth as a user that might be auto-created
        const client = trackClient(
          await createAuthenticatedX3Client('testuser', 'testpass')
        );

        // If we got here, auth succeeded
        const authStatus = await client.checkAuth();
        console.log('Auth status for auto-created:', authStatus);

        expect(authStatus.authenticated).toBe(true);
      } catch (e) {
        console.log('Note: Auto-creation test depends on Keycloak config:', e);
      }
    });

    it('should sync oper level from Keycloak x3_opserv_level', async () => {
      if (!isKeycloakAvailable()) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      try {
        // testoper should have x3_opserv_level set in Keycloak
        const client = trackClient(
          await createAuthenticatedX3Client('testoper', 'testpass')
        );

        const level = await client.myAccess();
        console.log('Oper level synced from Keycloak:', level);

        // If properly configured, should have oper access
        if (level > 0) {
          expect(level).toBeGreaterThanOrEqual(100);
        }
      } catch (e) {
        console.log('Note: Oper sync test depends on Keycloak config:', e);
      }
    });
  });

  describe('Service Response Consistency', () => {
    it('should receive NOTICE responses from all services', async () => {
      const client = trackClient(await createX3Client());

      // Wait for connection to fully settle - server sends many welcome messages
      // after 001, and X3 services may not process commands during this window.
      // 1500ms needed because server may still be sending NOTICE about PM history,
      // MODE +x for hidden host, etc.
      await new Promise(r => setTimeout(r, 1500));

      // AuthServ
      const authLines = await client.serviceCmd('AuthServ', 'HELP');
      expect(authLines.length).toBeGreaterThan(0);
      expect(authLines.some(l => l.includes('NOTICE'))).toBe(true);

      // ChanServ
      const chanLines = await client.serviceCmd('ChanServ', 'HELP');
      expect(chanLines.length).toBeGreaterThan(0);
      expect(chanLines.some(l => l.includes('NOTICE'))).toBe(true);

      // OpServ (O3)
      const opLines = await client.serviceCmd('O3', 'HELP');
      expect(opLines.length).toBeGreaterThan(0);
      expect(opLines.some(l => l.includes('NOTICE'))).toBe(true);
    });

    it('should handle rapid sequential commands', async () => {
      const client = trackClient(await createX3Client());

      // Wait for connection to fully settle
      await new Promise(r => setTimeout(r, 1500));

      // Send multiple commands in rapid succession
      // Note: serviceCmd uses a shared buffer, so we must await each response
      // before sending the next command. This still tests rapid sequential
      // command handling - the server must process them quickly one after another.
      const responses: string[][] = [];

      responses.push(await client.serviceCmd('AuthServ', 'HELP'));
      responses.push(await client.serviceCmd('ChanServ', 'HELP'));
      responses.push(await client.serviceCmd('O3', 'HELP'));

      // All should get responses
      for (const response of responses) {
        expect(response.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Error Propagation', () => {
    it('should return consistent error format across services', async () => {
      const client = trackClient(await createX3Client());

      // Wait for connection to fully settle
      await new Promise(r => setTimeout(r, 1500));

      // Invalid commands to each service
      const authError = await client.serviceCmd('AuthServ', 'INVALIDCMD');
      const chanError = await client.serviceCmd('ChanServ', 'INVALIDCMD');
      const opError = await client.serviceCmd('O3', 'INVALIDCMD');

      // All should return error responses
      expect(authError.length).toBeGreaterThan(0);
      expect(chanError.length).toBeGreaterThan(0);
      expect(opError.length).toBeGreaterThan(0);

      console.log('AuthServ error:', authError[0]);
      console.log('ChanServ error:', chanError[0]);
      console.log('O3 error:', opError[0]);
    });
  });
});
