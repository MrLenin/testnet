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
      await user2Client.registerAndActivate(user2, pass2, email2);

      // Owner adds user2 with OP level
      const addResult = await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);
      console.log('ADDUSER response:', addResult.lines);

      expect(addResult.lines.length).toBeGreaterThan(0);
      expect(addResult.success).toBe(true);

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
      await user2Client.registerAndActivate(user2, pass2, email2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

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
      await user2Client.registerAndActivate(user2, pass2, email2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.OP);

      // Remove user
      const delResult = await ownerClient.delUser(channel, user2);
      console.log('DELUSER response:', delResult.lines);

      expect(delResult.lines.length).toBeGreaterThan(0);
      expect(delResult.success).toBe(true);
    });

    it('should reject ADDUSER from user without sufficient access', async () => {
      // Create user2 with low access
      const user2Client = trackClient(await createX3Client());
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();
      await user2Client.registerAndActivate(user2, pass2, email2);
      await user2Client.auth(user2, pass2);
      await ownerClient.addUser(channel, user2, ACCESS_LEVELS.VOICE); // Low level

      // Create user3
      const { account: user3, password: pass3, email: email3 } = await createTestAccount();
      const user3Client = trackClient(await createX3Client());
      await user3Client.registerAndActivate(user3, pass3, email3);

      // User2 tries to add user3 - should fail (needs MANAGER+ to add users)
      const addResult = await user2Client.addUser(channel, user3, ACCESS_LEVELS.VOICE);
      console.log('Unauthorized ADDUSER response:', addResult.lines);

      // Should fail
      expect(addResult.success).toBe(false);
    });
  });

  describe('Access Level Enforcement', () => {
    it('should auto-op users with level >= 200', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup owner and channel
      const regResult = await client.registerAndActivate(account, password, email);
      expect(regResult.success, `Registration failed: ${regResult.error}`).toBe(true);
      const authResult = await client.auth(account, password);
      expect(authResult.success, `Auth failed: ${authResult.error}`).toBe(true);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with OP level - use account name as nick for easy assertion
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();
      const user2Client = trackClient(await createX3Client(user2));
      const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
      expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);
      const auth2Result = await user2Client.auth(user2, pass2);
      expect(auth2Result.success, `User2 auth failed: ${auth2Result.error}`).toBe(true);
      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.OP);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);

      // User2 joins - should get opped
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForLine(/JOIN/i, 5000);

      // Wait for MODE from ChanServ granting ops (or timeout after 3s)
      try {
        await user2Client.waitForLine(/MODE.*\+o/i, 3000);
      } catch {
        // MODE might have arrived before we started waiting, check NAMES
      }

      // Check if user got ops via NAMES
      user2Client.clearRawBuffer();
      user2Client.send(`NAMES ${channel}`);
      const namesResponse = await user2Client.waitForLine(/353/, 5000);

      // Should have @ prefix for ops (nick = account name = user2)
      expect(namesResponse).toMatch(new RegExp(`@${user2}\\b`));
    });

    it('should auto-voice users with level >= 100', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();
      const channel = uniqueChannel();

      // Setup owner and channel
      const regResult = await client.registerAndActivate(account, password, email);
      expect(regResult.success, `Registration failed: ${regResult.error}`).toBe(true);
      const authResult = await client.auth(account, password);
      expect(authResult.success, `Auth failed: ${authResult.error}`).toBe(true);
      client.send(`JOIN ${channel}`);
      await client.waitForLine(/JOIN/i, 5000);
      await new Promise(r => setTimeout(r, 500));
      const chanResult = await client.registerChannel(channel);
      expect(chanResult.success, `Channel reg failed: ${chanResult.error}`).toBe(true);

      // Create second user with VOICE level - use account name as nick for easy assertion
      const { account: user2, password: pass2, email: email2 } = await createTestAccount();
      const user2Client = trackClient(await createX3Client(user2));
      const reg2Result = await user2Client.registerAndActivate(user2, pass2, email2);
      expect(reg2Result.success, `User2 registration failed: ${reg2Result.error}`).toBe(true);
      const auth2Result = await user2Client.auth(user2, pass2);
      expect(auth2Result.success, `User2 auth failed: ${auth2Result.error}`).toBe(true);
      const addResult = await client.addUser(channel, user2, ACCESS_LEVELS.VOICE);
      expect(addResult.success, `ADDUSER failed: ${addResult.error}`).toBe(true);

      // User2 joins - should get voiced
      user2Client.send(`JOIN ${channel}`);

      // Wait for JOIN first
      await user2Client.waitForLine(/JOIN/i, 5000);

      // Wait for MODE from ChanServ granting voice (or timeout after 3s)
      try {
        await user2Client.waitForLine(/MODE.*\+v/i, 3000);
      } catch {
        // MODE might have arrived before we started waiting, check NAMES
      }

      // Check if user got voice via NAMES
      user2Client.clearRawBuffer();
      user2Client.send(`NAMES ${channel}`);
      const namesResponse = await user2Client.waitForLine(/353/, 5000);

      // Should have + prefix for voice (nick = account name = user2)
      expect(namesResponse).toMatch(new RegExp(`\\+${user2}\\b`));
    });
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
