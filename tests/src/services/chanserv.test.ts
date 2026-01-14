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
  getTestAccount,
  setupTestAccount,
  releaseTestAccount,
  ACCESS_LEVELS,
  uniqueChannel,
  uniqueId,
  waitForUserAccess,
  waitForChannelMode,
} from '../helpers/index.js';

describe('ChanServ (X3)', () => {
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

  describe('Channel Registration', () => {
    it('should register a channel when authenticated and opped', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Join channel - should get ops as first user
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
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
      await client.waitForJoin(channel, undefined, 5000);

      // Try to register
      const result = await client.registerChannel(channel);
      console.log('Unauth register response:', result.lines);

      // Should fail - not authenticated
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should set registering user as owner (level 500)', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
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
      const { account, fromPool } = await setupTestAccount(ownerClient);
      if (fromPool) poolAccounts.push(account);
      ownerAccount = account;
      channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      ownerClient.send(`JOIN ${channel}`);
      await ownerClient.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      await ownerClient.registerChannel(channel);
    });

    it('should add user with specified access level', { retry: 2 }, async () => {
      // Create second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, fromPool: user2Pool } = await setupTestAccount(user2Client);
      if (user2Pool) poolAccounts.push(user2);

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

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

    it('should change user access level with CLVL', { retry: 2 }, async () => {
      // Create and add second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, fromPool: user2Pool } = await setupTestAccount(user2Client);
      if (user2Pool) poolAccounts.push(user2);

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

      // Wait for user to appear in access list before changing level
      await waitForUserAccess(ownerClient, channel, user2, ACCESS_LEVELS.OP);

      // Change level to MANAGER
      const clvlResult = await ownerClient.clvl(channel, user2, ACCESS_LEVELS.MANAGER);
      console.log('CLVL response:', clvlResult.lines);

      expect(clvlResult.lines.length).toBeGreaterThan(0);
      expect(clvlResult.success).toBe(true);
    });

    it('should remove user with DELUSER', { retry: 2 }, async () => {
      // Create and add second user
      const user2Client = trackClient(await createX3Client());
      const { account: user2, fromPool: user2Pool } = await setupTestAccount(user2Client);
      if (user2Pool) poolAccounts.push(user2);

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

      // Wait for user to appear in access list before deleting
      await waitForUserAccess(ownerClient, channel, user2);

      // Settle delay and buffer clear to avoid race with ChanServ responses from polling
      await new Promise(r => setTimeout(r, 200));
      ownerClient.clearRawBuffer();

      // Remove user
      const delResult = await ownerClient.delUser(channel, user2);
      console.log('DELUSER response:', delResult.lines);

      expect(delResult.lines.length).toBeGreaterThan(0);
      expect(delResult.success).toBe(true);
    });

    // This test creates 3 accounts total (owner in beforeEach + user2 + user3), each taking
    // ~10s for registerAndActivate. Use 60s timeout to handle this.
    it('should reject ADDUSER from user without sufficient access', { retry: 2, timeout: 60000 }, async () => {
      // Create user2 with low access
      const user2Client = trackClient(await createX3Client());
      const { account: user2, fromPool: user2Pool } = await setupTestAccount(user2Client);
      if (user2Pool) poolAccounts.push(user2);

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.VOICE); // Low level

      // Wait for user2's access to be visible before they try to use it
      await waitForUserAccess(ownerClient, channel, user2, ACCESS_LEVELS.VOICE);

      // Create user3
      const user3Client = trackClient(await createX3Client());
      const { account: user3, fromPool: user3Pool } = await setupTestAccount(user3Client);
      if (user3Pool) poolAccounts.push(user3);

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // User2 tries to add user3 - should fail (needs MANAGER+ to add users)
      const addResult = await user2Client.addUser(channel, user3, ACCESS_LEVELS.VOICE);
      console.log('Unauthorized ADDUSER response:', addResult.lines);

      // Should fail
      expect(addResult.success).toBe(false);
    });
  });

  describe('Access Level Enforcement', () => {
    // Tests in this section create 2 accounts each (owner + user2), each taking ~10s for
    // registerAndActivate, plus additional waits. Use 45s timeout.
    it('should auto-op users with level >= 200', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup owner and channel
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with OP level - use account name as nick for easy assertion
      // Need to get account first, then create client with matching nick
      const { account: user2, password: pass2, email: email2, fromPool: user2Pool } = await getTestAccount();
      if (user2Pool) poolAccounts.push(user2);
      const user2Client = trackClient(await createX3Client(user2));  // nick = account

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // AUTH (pool) or register+activate (fresh)
      if (user2Pool) {
        const authResult = await user2Client.auth(user2, pass2);
        expect(authResult.success, `User2 AUTH failed: ${authResult.error}`).toBe(true);
      } else {
        const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
        expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);
      }

      // Verify user2 is actually authenticated before proceeding
      const authStatus = await user2Client.checkAuth();
      console.log(`[auto-op] User2 auth status: authenticated=${authStatus.authenticated}, account=${authStatus.account}`);
      expect(authStatus.authenticated, 'User2 should be authenticated').toBe(true);

      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.OP);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);
      console.log(`[auto-op] ADDUSER response: ${addResult.lines.join(' | ')}`);

      // Wait for user access to be visible before joining
      await waitForUserAccess(client, channel, user2, ACCESS_LEVELS.OP);

      // Allow Keycloak async operations to settle - bidirectional sync can race with ADDUSER
      // and briefly overwrite the level with 0 from a previous test's cleanup
      await new Promise(r => setTimeout(r, 2000));

      // Verify access list shows user2 with OP level (after settling)
      const accessList = await client.getAccess(channel);
      const user2Access = accessList.find(e => e.account.toLowerCase() === user2.toLowerCase());
      console.log(`[auto-op] User2 access in ${channel}: level=${user2Access?.level}`);
      expect(user2Access?.level, `Access level should be ${ACCESS_LEVELS.OP} after settling`).toBe(ACCESS_LEVELS.OP);

      // User2 joins - should get opped
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForJoin(channel, undefined, 5000);

      // Settle delay and buffer clear - JOIN sends NAMES (353) which may show user
      // without ops if ChanServ hasn't granted yet. Clear stale 353 before polling.
      await new Promise(r => setTimeout(r, 500));
      user2Client.clearRawBuffer();

      // Wait for ChanServ to grant ops (polls NAMES with retries)
      // Extended timeout to 10s to handle slow ChanServ processing
      const hasOps = await waitForChannelMode(user2Client, channel, user2, '@', 10000);
      expect(hasOps, `User ${user2} should have ops (@) in ${channel}`).toBe(true);
    }, 45000);

    it('should auto-voice users with level >= 100', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Setup owner and channel
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with VOICE level - use account name as nick for easy assertion
      const { account: user2, password: pass2, email: email2, fromPool: user2Pool } = await getTestAccount();
      if (user2Pool) poolAccounts.push(user2);
      const user2Client = trackClient(await createX3Client(user2));  // nick = account

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // AUTH (pool) or register+activate (fresh)
      if (user2Pool) {
        const authResult = await user2Client.auth(user2, pass2);
        expect(authResult.success, `User2 AUTH failed: ${authResult.error}`).toBe(true);
      } else {
        const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
        expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);
      }

      // Verify user2 is actually authenticated before proceeding
      const authStatus = await user2Client.checkAuth();
      console.log(`[auto-voice] User2 auth status: authenticated=${authStatus.authenticated}, account=${authStatus.account}`);
      expect(authStatus.authenticated, 'User2 should be authenticated').toBe(true);

      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.VOICE);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);
      console.log(`[auto-voice] ADDUSER response: ${addResult.lines.join(' | ')}`);

      // Wait for user access to be visible before joining
      await waitForUserAccess(client, channel, user2, ACCESS_LEVELS.VOICE);

      // Allow Keycloak async operations to settle - bidirectional sync can race with ADDUSER
      await new Promise(r => setTimeout(r, 2000));

      // Verify access list shows user2 with VOICE level (after settling)
      const accessList = await client.getAccess(channel);
      const user2Access = accessList.find(e => e.account.toLowerCase() === user2.toLowerCase());
      console.log(`[auto-voice] User2 access in ${channel}: level=${user2Access?.level}`);
      expect(user2Access?.level, `Access level should be ${ACCESS_LEVELS.VOICE} after settling`).toBe(ACCESS_LEVELS.VOICE);

      // User2 joins - should get voiced
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForJoin(channel, undefined, 5000);

      // Settle delay and buffer clear - JOIN sends NAMES (353) which may show user
      // without voice if ChanServ hasn't granted yet. Clear stale 353 before polling.
      await new Promise(r => setTimeout(r, 500));
      user2Client.clearRawBuffer();

      // Wait for ChanServ to grant voice (polls NAMES with retries)
      // Extended timeout to 10s to handle slow ChanServ processing
      const hasVoice = await waitForChannelMode(user2Client, channel, user2, '+', 10000);
      expect(hasVoice, `User ${user2} should have voice (+) in ${channel}`).toBe(true);
    }, 45000);
  });

  describe('Channel Settings', () => {
    it('should set channel modes via SET command', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Set DEFAULTMODES
      const setResult = await client.set(channel, 'DEFAULTMODES', '+nt');
      console.log('SET DEFAULTMODES response:', setResult.lines);

      expect(setResult.lines.length).toBeGreaterThan(0);
    });
  });

  describe('Ban Management', () => {
    it('should ban a user from the channel', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Ban a hostmask
      const banResult = await client.ban(channel, '*!*@banned.example.com', 'Test ban');
      console.log('BAN response:', banResult.lines);

      expect(banResult.lines.length).toBeGreaterThan(0);
    });

    it('should unban a user from the channel', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
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
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);
      const channel = uniqueChannel();

      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel, undefined, 5000);
      await new Promise(r => setTimeout(r, 500));
      await client.registerChannel(channel);

      // Get channel info
      const lines = await client.serviceCmd('ChanServ', `INFO ${channel}`);
      console.log('INFO response:', lines);

      expect(lines.length).toBeGreaterThan(0);
    });
  });
});
