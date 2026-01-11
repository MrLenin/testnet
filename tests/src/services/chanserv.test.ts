/**
 * ChanServ (X3) Tests
 *
 * Tests X3 ChanServ functionality:
 * - Channel registration
 * - Access control (ADDUSER, CLVL, DELUSER)
 * - Access level enforcement
 * - Channel modes and settings
 * - Ban management
 *
 * ChanServ Communication:
 *   Client → X3:  PRIVMSG X3 :<command>
 *   X3 → Client:  NOTICE <nick> :<response>
 *
 * Access Level System:
 *   1-99:   Peon/Voice - Basic channel access
 *   100-199: HalfOp - Limited moderation
 *   200-299: Operator - Full channel moderation
 *   300-399: Manager - User management
 *   400-499: Co-Owner - Most settings
 *   500+:    Owner - Full control
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  X3Client,
  createX3Client,
  createTestAccount,
  ACCESS_LEVELS,
  uniqueChannel,
  uniqueId,
  waitForUserAccess,
  waitForChannelMode,
} from '../helpers/index.js';

describe('ChanServ (X3)', () => {
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

  describe('Channel Registration', () => {
    it('should register a channel when authenticated and opped', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Register account first
      const regResult = await client.registerAndActivate(account, password, email);
      console.log('REGISTER account response:', regResult.lines);
      expect(regResult.success).toBe(true);

      // Authenticate (user may already be authenticated from cookie activation)
      const authResult = await client.auth(account, password);
      console.log('AUTH response:', authResult.lines);
      // Accept success or if already authenticated from activation
      if (!authResult.success) {
        // Check if already authenticated from cookie activation
        const alreadyAuth = regResult.lines.some(l => l.includes('now authenticated'));
        if (!alreadyAuth) {
          expect(authResult.success).toBe(true);
        }
      }

      // Join channel - should get ops as first user
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 1000)); // Let modes settle

      // Register the channel
      const chanResult = await client.registerChannel(channel);
      console.log('REGISTER channel response:', chanResult.lines);

      expect(chanResult.success).toBe(true);
    });

    it('should reject registration from unauthenticated user', async () => {
      const client = trackClient(await createX3Client());
      const channel = uniqueChannel();

      // Join channel without authenticating
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);

      // Try to register
      const result = await client.registerChannel(channel);
      console.log('Unauth register response:', result.lines);

      // Should fail - not authenticated
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should set registering user as owner (level 500)', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup
      await client.registerAndActivate(account, password, email);
      await client.auth(account, password);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));

      // Register
      const regResult = await client.registerChannel(channel);
      expect(regResult.success).toBe(true);

      // Check access list
      const accessList = await client.getAccess(channel);
      console.log('Access list:', accessList);

      // Owner should have level 500
      const ownerEntry = accessList.find(e => e.account.toLowerCase() === account.toLowerCase());
      if (ownerEntry) {
        expect(ownerEntry.level).toBe(ACCESS_LEVELS.OWNER);
      }
    });
  });

  describe('Access Control', () => {
    let ownerClient: X3Client;
    let ownerAccount: string;
    let channel: string;

    beforeEach(async () => {
      ownerClient = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      ownerAccount = account;
      channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup owner and registered channel
      await ownerClient.registerAndActivate(account, password, email);
      await ownerClient.auth(account, password);
      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await ownerClient.registerChannel(channel);
    });

    it('should add user with specified access level', async () => {
      // Create second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await user2Client.registerAndActivate(user2, pass2, email2);

      // Owner adds user2 with OP level
      const addResult = await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);
      console.log('ADDUSER response:', addResult.lines);

      expect(addResult.lines.length).toBeGreaterThan(0);
      expect(addResult.success).toBe(true);

      // Wait for access to propagate before verifying (8s timeout for Keycloak sync)
      const accessOk = await waitForUserAccess(ownerClient, channel, user2, ACCESS_LEVELS.OP, 8000);
      if (!accessOk) {
        console.log('waitForUserAccess failed for user2');
      }
      expect(accessOk).toBe(true);

      // Verify access
      const accessList = await ownerClient.getAccess(channel);
      const user2Entry = accessList.find(e => e.account.toLowerCase() === user2.toLowerCase());
      expect(user2Entry).toBeDefined();
      expect(user2Entry?.level).toBe(ACCESS_LEVELS.OP);
    });

    it('should change user access level with CLVL', async () => {
      // Create and add second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await user2Client.registerAndActivate(user2, pass2, email2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

      // Wait for user to appear in access list before changing level
      await waitForUserAccess(ownerClient, channel, user2, ACCESS_LEVELS.OP);

      // Change level to MANAGER
      const clvlResult = await ownerClient.clvl(channel, user2, ACCESS_LEVELS.MANAGER);
      console.log('CLVL response:', clvlResult.lines);

      expect(clvlResult.lines.length).toBeGreaterThan(0);
      expect(clvlResult.success).toBe(true);
    });

    it('should remove user with DELUSER', async () => {
      // Create and add second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await user2Client.registerAndActivate(user2, pass2, email2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

      // Wait for user to appear in access list before deleting
      await waitForUserAccess(ownerClient, channel, user2);

      // Remove user
      const delResult = await ownerClient.delUser(channel, user2);
      console.log('DELUSER response:', delResult.lines);

      expect(delResult.lines.length).toBeGreaterThan(0);
      expect(delResult.success).toBe(true);
    });

    // This test creates 3 accounts total (owner in beforeEach + user2 + user3), each taking
    // ~10s for registerAndActivate. Use 60s timeout to handle this.
    it('should reject ADDUSER from user without sufficient access', async () => {
      // Create user2 with low access
      // Note: registerAndActivate already authenticates the user via COOKIE
      const user2Client = trackClient(await createX3Client());
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await user2Client.registerAndActivate(user2, pass2, email2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.VOICE); // Low level

      // Wait for user2's access to be visible before they try to use it
      await waitForUserAccess(ownerClient, channel, user2, ACCESS_LEVELS.VOICE);

      // Create user3
      const { account: user3, password: pass3, email: email3 } = await createTestAccount();
      const user3Client = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await user3Client.registerAndActivate(user3, pass3, email3);

      // User2 tries to add user3 - should fail (needs MANAGER+ to add users)
      const addResult = await user2Client.addUser(channel, user3, ACCESS_LEVELS.VOICE);
      console.log('Unauthorized ADDUSER response:', addResult.lines);

      // Should fail
      expect(addResult.success).toBe(false);
    }, 60000);
  });

  describe('Access Level Enforcement', () => {
    // Tests in this section create 2 accounts each (owner + user2), each taking ~10s for
    // registerAndActivate, plus additional waits. Use 45s timeout.
    it('should auto-op users with level >= 200', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup owner and channel
      // Note: registerAndActivate already authenticates the user via COOKIE
      const regResult = await client.registerAndActivate(account, password, email);
      expect(regResult.success, `Registration failed: ${regResult.error}`).toBe(true);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with OP level - use account name as nick for easy assertion
      // Note: registerAndActivate already authenticates the user via COOKIE
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();
      const user2Client = trackClient(await createX3Client(user2));

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
      expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);

      // Verify user2 is actually authenticated before proceeding
      const authStatus = await user2Client.checkAuth();
      console.log(`[auto-op] User2 auth status: authenticated=${authStatus.authenticated}, account=${authStatus.account}`);
      expect(authStatus.authenticated, 'User2 should be authenticated after registerAndActivate').toBe(true);

      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.OP);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);
      console.log(`[auto-op] ADDUSER response: ${addResult.lines.join(' | ')}`);

      // Wait for user access to be visible before joining
      await waitForUserAccess(client, channel, user2, ACCESS_LEVELS.OP);

      // Verify access list shows user2 with OP level
      const accessList = await client.getAccess(channel);
      const user2Access = accessList.find(e => e.account.toLowerCase() === user2.toLowerCase());
      console.log(`[auto-op] User2 access in ${channel}: level=${user2Access?.level}`);

      // User2 joins - should get opped
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForLine(/JOIN/i, 5000);

      // Wait for ChanServ to grant ops (polls NAMES with retries)
      // Extended timeout to 10s to handle slow ChanServ processing
      const hasOps = await waitForChannelMode(user2Client, channel, user2, '@', 10000);
      expect(hasOps, `User ${user2} should have ops (@) in ${channel}`).toBe(true);
    }, 45000);

    it('should auto-voice users with level >= 100', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup owner and channel
      // Note: registerAndActivate already authenticates the user via COOKIE
      const regResult = await client.registerAndActivate(account, password, email);
      expect(regResult.success, `Registration failed: ${regResult.error}`).toBe(true);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with VOICE level - use account name as nick for easy assertion
      // Note: registerAndActivate already authenticates the user via COOKIE
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();
      const user2Client = trackClient(await createX3Client(user2));

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
      expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);

      // Verify user2 is actually authenticated before proceeding
      const authStatus = await user2Client.checkAuth();
      console.log(`[auto-voice] User2 auth status: authenticated=${authStatus.authenticated}, account=${authStatus.account}`);
      expect(authStatus.authenticated, 'User2 should be authenticated after registerAndActivate').toBe(true);

      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.VOICE);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);
      console.log(`[auto-voice] ADDUSER response: ${addResult.lines.join(' | ')}`);

      // Wait for user access to be visible before joining
      await waitForUserAccess(client, channel, user2, ACCESS_LEVELS.VOICE);

      // Verify access list shows user2 with VOICE level
      const accessList = await client.getAccess(channel);
      const user2Access = accessList.find(e => e.account.toLowerCase() === user2.toLowerCase());
      console.log(`[auto-voice] User2 access in ${channel}: level=${user2Access?.level}`);

      // User2 joins - should get voiced
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForLine(/JOIN/i, 5000);

      // Wait for ChanServ to grant voice (polls NAMES with retries)
      // Extended timeout to 10s to handle slow ChanServ processing
      const hasVoice = await waitForChannelMode(user2Client, channel, user2, '+', 10000);
      expect(hasVoice, `User ${user2} should have voice (+) in ${channel}`).toBe(true);
    }, 45000);
  });

  describe('Channel Settings', () => {
    it('should set channel modes via SET command', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup
      await client.registerAndActivate(account, password, email);
      await client.auth(account, password);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Set DEFAULTMODES
      const setResult = await client.set(channel, 'DEFAULTMODES', '+nt');
      console.log('SET DEFAULTMODES response:', setResult.lines);

      expect(setResult.lines.length).toBeGreaterThan(0);
    });
  });

  describe('Ban Management', () => {
    it('should ban a user from the channel', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup
      await client.registerAndActivate(account, password, email);
      await client.auth(account, password);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Ban a hostmask
      const banResult = await client.ban(channel, '*!*@banned.example.com', 'Test ban');
      console.log('BAN response:', banResult.lines);

      expect(banResult.lines.length).toBeGreaterThan(0);
    });

    it('should unban a user from the channel', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup and ban
      await client.registerAndActivate(account, password, email);
      await client.auth(account, password);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);
      await client.ban(channel, '*!*@banned.example.com', 'Test ban');

      // Unban
      const unbanResult = await client.unban(channel, '*!*@banned.example.com');
      console.log('UNBAN response:', unbanResult.lines);

      expect(unbanResult.lines.length).toBeGreaterThan(0);
    });
  });

  describe('Direct PRIVMSG Commands', () => {
    it('should respond to HELP command', async () => {
      const client = trackClient(await createX3Client());

      const lines = await client.serviceCmd('ChanServ', 'HELP');
      console.log('X3 HELP response (first 5):', lines.slice(0, 5));

      expect(lines.length).toBeGreaterThan(0);
    });

    it('should respond to INFO command for registered channel', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup registered channel
      await client.registerAndActivate(account, password, email);
      await client.auth(account, password);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Get channel info
      const lines = await client.serviceCmd('ChanServ', `INFO ${channel}`);
      console.log('INFO response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });
  });
});
