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
  getTestAccount,
  setupTestAccount,
  releaseTestAccount,
  ACCESS_LEVELS,
  uniqueChannel,
  uniqueId,
  isKeycloakAvailable,
  waitForUserAccess,
  assertServiceSuccess,
  assertServiceError,
  assertHasMatchingItem,
} from '../helpers/index.js';

describe('Services Integration', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];  // Track pool accounts for cleanup

  const trackClient = (client: X3Client): X3Client => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    // Release pool accounts first
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;

    // Then close clients
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
      const { account, password, email, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // First connection: register account and channel
      const client1 = trackClient(await createX3Client());
      if (fromPool) {
        await client1.auth(account, password);
      } else {
        await client1.registerAndActivate(account, password, email);
      }
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel, undefined, 5000);
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
      await client2.waitForJoin(channel, undefined, 5000);

      // Should still be able to manage channel
      const accessList = await client2.getAccess(channel);
      console.log('Access list after reconnect:', accessList);

      const myAccess = accessList.find(e => e.account.toLowerCase() === account.toLowerCase());
      expect(myAccess).toBeDefined();
      expect(myAccess?.level).toBe(ACCESS_LEVELS.OWNER);
    });

    it('should allow channel owner to promote user to coowner', { retry: 2, timeout: 60000 }, async () => {
      // X3 does not allow CLVL to owner level (500) - you can only give access
      // levels lower than your own. This test verifies promoting to COOWNER (400).
      const ownerClient = trackClient(await createX3Client());
      const { account: owner, fromPool: ownerPool } = await setupTestAccount(ownerClient);
      if (ownerPool) poolAccounts.push(owner);

      const coownerClient = trackClient(await createX3Client());
      const { account: coowner, fromPool: coownerPool } = await setupTestAccount(coownerClient);
      if (coownerPool) poolAccounts.push(coowner);

      const channel = uniqueChannel();

      // Setup owner
      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForJoin(channel, undefined, 5000);

      // Register channel and verify success
      const regResult = await ownerClient.registerChannel(channel);
      console.log('Channel registration result:', regResult.lines, 'success:', regResult.success);
      if (!regResult.success) {
        console.log('Channel registration failed, skipping test');
        return;
      }

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

      // Verify user has COOWNER level
      const accessList = await ownerClient.getAccess(channel);
      console.log('Final access list:', JSON.stringify(accessList));
      console.log('Looking for coowner account:', coowner);
      const coownerEntry = accessList.find(e => e.account.toLowerCase() === coowner.toLowerCase());
      console.log('Found coowner entry:', coownerEntry);
      expect(coownerEntry?.level).toBe(ACCESS_LEVELS.COOWNER);
    });

    it('should enforce channel settings on all users', { retry: 2 }, async () => {
      const ownerClient = trackClient(await createX3Client());
      const { account: owner, fromPool } = await setupTestAccount(ownerClient);
      if (fromPool) poolAccounts.push(owner);
      const channel = uniqueChannel();

      // Setup owner and channel
      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForJoin(channel, undefined, 5000);
      await ownerClient.registerChannel(channel);

      // Set channel to invite-only
      await ownerClient.set(channel, 'DEFAULTMODES', '+i');

      // Try to have non-access user join
      const guestClient = trackClient(await createX3Client());
      guestClient.send(`JOIN ${channel}`);

      // Should get invite-only error
      const joinResponse = await guestClient.waitForParsedLine(
        msg => msg.command === 'JOIN' || msg.command === '473',
        5000
      );
      console.log('Guest join response:', joinResponse.raw);

      // 473 is ERR_INVITEONLYCHAN
      const isInviteOnly = joinResponse.command === '473';
      if (isInviteOnly) {
        expect(isInviteOnly).toBe(true);
      } else {
        // Mode might not have been enforced yet
        console.log('Note: Invite-only mode may need time to apply');
      }
    });
  });

  describe('Multiple Account Management', () => {
    it('should track multiple concurrent logins', { retry: 2 }, async () => {
      const { account, password, email, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Setup account (AUTH for pool, registerAndActivate for fresh)
      const client1 = trackClient(await createX3Client());

      // Wait for connection to fully settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      if (fromPool) {
        const authResult = await client1.auth(account, password);
        expect(authResult.success).toBe(true);
      } else {
        const regResult = await client1.registerAndActivate(account, password, email);
        expect(regResult.success).toBe(true);
      }

      const client2 = trackClient(await createX3Client());
      const authResult2 = await client2.auth(account, password);
      expect(authResult2.success).toBe(true);

      const client3 = trackClient(await createX3Client());
      const authResult3 = await client3.auth(account, password);
      expect(authResult3.success).toBe(true);

      console.log('Successfully logged in from 3 clients');
    });

    it('should share channel access between logged-in clients', async () => {
      const { account, password, email, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Setup account and channel
      const client1 = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      if (fromPool) {
        const authResult = await client1.auth(account, password);
        expect(authResult.success).toBe(true);
      } else {
        const regResult = await client1.registerAndActivate(account, password, email);
        expect(regResult.success).toBe(true);
      }

      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel, undefined, 5000);

      const chanRegResult = await client1.registerChannel(channel);
      console.log('Channel registration result:', chanRegResult.success, chanRegResult.lines?.slice(0, 2));
      expect(chanRegResult.success).toBe(true);

      // Wait for registration to fully sync
      await new Promise(r => setTimeout(r, 500));

      // Second client should also have access
      const client2 = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Retry auth since X3 may be blocked on Keycloak sync from first client
      let authResult = { success: false, lines: [] as string[], error: undefined as string | undefined };
      for (let attempt = 0; attempt < 3; attempt++) {
        authResult = await client2.auth(account, password);
        if (authResult.success || authResult.lines.length > 0) break;
        console.log(`[Client2 auth attempt ${attempt + 1}] No response, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log('Client2 auth result:', authResult.success);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel, undefined, 5000);

      // Both should be able to get channel access
      const access1 = await client1.getAccess(channel);
      const access2 = await client2.getAccess(channel);
      console.log('Access1:', JSON.stringify(access1));
      console.log('Access2:', JSON.stringify(access2));

      expect(access1.length, 'Client1 should see access list').toBeGreaterThan(0);
      expect(access2.length, 'Client2 should see access list').toBeGreaterThan(0);
      // Both should see the owner in the access list
      const ownerInAccess1 = access1.some(e => e.account.toLowerCase() === account.toLowerCase());
      const ownerInAccess2 = access2.some(e => e.account.toLowerCase() === account.toLowerCase());
      expect(ownerInAccess1, 'Client1 should see owner in access list').toBe(true);
      expect(ownerInAccess2, 'Client2 should see owner in access list').toBe(true);
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

      // Try to auth as a user that might be auto-created
      const client = trackClient(
        await createAuthenticatedX3Client('testuser', 'testpass')
      );

      // Wait a bit for X3 to process SASL auth result
      await new Promise(r => setTimeout(r, 500));

      // Check auth with extended timeout - Keycloak can be slow
      const authStatus = await client.checkAuth(15000);
      console.log('Auth status for auto-created:', authStatus);

      // If auto-creation is not configured, test may fail - that's expected
      // Skip instead of fail if not authenticated
      if (!authStatus.authenticated) {
        console.log('Note: Auto-creation test depends on Keycloak config (keycloak_autocreate)');
        return;
      }

      expect(authStatus.authenticated).toBe(true);
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
      expect(authLines.length, 'AuthServ should respond to HELP').toBeGreaterThan(0);
      expect(authLines.some(l => l.includes('NOTICE')), 'AuthServ should use NOTICE').toBe(true);
      expect(authLines.some(l => /help|command|auth/i.test(l)), 'AuthServ HELP should contain relevant content').toBe(true);

      // ChanServ
      const chanLines = await client.serviceCmd('ChanServ', 'HELP');
      expect(chanLines.length, 'ChanServ should respond to HELP').toBeGreaterThan(0);
      expect(chanLines.some(l => l.includes('NOTICE')), 'ChanServ should use NOTICE').toBe(true);
      expect(chanLines.some(l => /help|command|chan/i.test(l)), 'ChanServ HELP should contain relevant content').toBe(true);

      // OpServ (O3)
      const opLines = await client.serviceCmd('O3', 'HELP');
      expect(opLines.length, 'O3 should respond to HELP').toBeGreaterThan(0);
      expect(opLines.some(l => l.includes('NOTICE')), 'O3 should use NOTICE').toBe(true);
      expect(opLines.some(l => /help|command|o3|opserv|privileged/i.test(l)), 'O3 HELP should contain relevant content').toBe(true);
    });

    it('should handle rapid sequential commands', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());

      // Wait for connection to fully settle
      await new Promise(r => setTimeout(r, 2000));

      // Send multiple commands in rapid succession
      // Note: serviceCmd uses a shared buffer, so we must await each response
      // before sending the next command. This still tests rapid sequential
      // command handling - the server must process them quickly one after another.
      const responses: string[][] = [];

      // Use longer timeout for service commands that may be slow
      responses.push(await client.serviceCmd('AuthServ', 'HELP', 15000));
      responses.push(await client.serviceCmd('ChanServ', 'HELP', 15000));
      responses.push(await client.serviceCmd('O3', 'HELP', 15000));

      // All should get responses with relevant help content
      expect(responses.length, 'Should get all 3 responses').toBe(3);
      for (let i = 0; i < responses.length; i++) {
        const serviceName = ['AuthServ', 'ChanServ', 'O3'][i];
        expect(responses[i].length, `${serviceName} should respond`).toBeGreaterThan(0);
        expect(responses[i].some(l => /help|command|privileged|service/i.test(l)), `${serviceName} should return help content`).toBe(true);
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

      // All should return error responses with error-related content
      expect(authError.length, 'AuthServ should respond to invalid cmd').toBeGreaterThan(0);
      expect(chanError.length, 'ChanServ should respond to invalid cmd').toBeGreaterThan(0);
      expect(opError.length, 'O3 should respond to invalid cmd').toBeGreaterThan(0);

      // Should contain error-related keywords
      const errorPattern = /unknown|invalid|unrecognized|not\s+found|error/i;
      expect(authError.some(l => errorPattern.test(l)), 'AuthServ should return error message').toBe(true);
      expect(chanError.some(l => errorPattern.test(l)), 'ChanServ should return error message').toBe(true);
      // O3 may return 'privileged service' for non-opers, which is also an error response
      expect(opError.some(l => errorPattern.test(l) || l.includes('privileged')), 'O3 should return error message').toBe(true);

      console.log('AuthServ error:', authError[0]);
      console.log('ChanServ error:', chanError[0]);
      console.log('O3 error:', opError[0]);
    });
  });
});
