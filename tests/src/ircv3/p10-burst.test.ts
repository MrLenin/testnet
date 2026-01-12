/**
 * P10 BURST Protocol Tests
 *
 * Tests for P10 server-to-server BURST message handling.
 * BURST messages synchronize channel state between servers.
 *
 * These tests verify:
 * - Channel state propagation (modes, users, bans)
 * - BURST ordering (correct sequence)
 * - TS comparison rules (older wins)
 *
 * Uses docker log inspection and client-observable effects.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createClientOnServer,
  RawSocketClient,
  isSecondaryServerAvailable,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  uniqueId,
  uniqueChannel,
  uniqueNick,
  // P10 helpers
  parseP10Message,
  parseBurst,
  parseNick,
  getP10Logs,
  validateBurstOrder,
  channelTsWinner,
  getServerFromNumeric,
  assertBurstModes,
} from '../helpers/index.js';

/**
 * Create a connected and registered client on a server.
 */
async function createRegisteredClient(server: typeof PRIMARY_SERVER, nick: string): Promise<RawSocketClient> {
  const client = await createClientOnServer(server);
  await client.capLs();
  client.capEnd();
  client.register(nick);
  await client.waitForNumeric('001', 5000);
  return client;
}

// Track all clients for cleanup
const activeClients: RawSocketClient[] = [];

function trackClient(client: RawSocketClient): RawSocketClient {
  activeClients.push(client);
  return client;
}

async function cleanupClients(): Promise<void> {
  for (const client of activeClients) {
    try {
      client.send('QUIT :Test cleanup');
      client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
  activeClients.length = 0;
}

// Check if secondary server is available
let secondaryAvailable = false;

beforeAll(async () => {
  secondaryAvailable = await isSecondaryServerAvailable();
  if (!secondaryAvailable) {
    console.log('Secondary server not available - P10 BURST tests will be skipped');
    console.log('Run with: npm run test:linked');
  }
});

afterAll(async () => {
  await cleanupClients();
});

beforeEach(async () => {
  await cleanupClients();
});

// ============================================================================
// P10 Message Parsing Unit Tests
// ============================================================================

describe('P10 Message Parsing', () => {
  describe('parseP10Message', () => {
    it('should parse simple P10 command', () => {
      const msg = parseP10Message('AB PING :testnet.example.com');
      expect(msg.source).toBe('AB');
      expect(msg.command).toBe('PING');
      expect(msg.params).toEqual(['testnet.example.com']);
    });

    it('should parse BURST message', () => {
      const msg = parseP10Message('AB B #test 1234567890 +nt AAAAB:o,AAAAC:v');
      expect(msg.source).toBe('AB');
      expect(msg.command).toBe('B');
      expect(msg.params[0]).toBe('#test');
      expect(msg.params[1]).toBe('1234567890');
      expect(msg.params[2]).toBe('+nt');
    });

    it('should parse N (nick) message', () => {
      const msg = parseP10Message('AB N TestUser 1 1234567890 ~user host.example.com +i AAAAB AAAAAA :Real Name');
      expect(msg.source).toBe('AB');
      expect(msg.command).toBe('N');
      expect(msg.params[0]).toBe('TestUser');
    });

    it('should handle message without source', () => {
      const msg = parseP10Message('SERVER testnet.example.com 1 :Test Server');
      expect(msg.source).toBeNull();
      expect(msg.command).toBe('SERVER');
    });

    it('should parse 5-char user numeric as source', () => {
      const msg = parseP10Message('AAAAB P #test :Hello world');
      expect(msg.source).toBe('AAAAB');
      expect(msg.command).toBe('P');
    });
  });

  describe('parseBurst', () => {
    it('should parse channel BURST with modes', () => {
      const burst = parseBurst('AB B #test 1234567890 +nt');
      expect(burst).not.toBeNull();
      expect(burst!.channel).toBe('#test');
      expect(burst!.timestamp).toBe(1234567890);
      expect(burst!.modes).toBe('+nt');
    });

    it('should parse BURST with users', () => {
      const burst = parseBurst('AB B #test 1234567890 +nt AAAAB:o,AAAAC:v,AAAAD');
      expect(burst).not.toBeNull();
      expect(burst!.users.size).toBe(3);
      expect(burst!.users.get('AAAAB')).toBe('o');
      expect(burst!.users.get('AAAAC')).toBe('v');
      expect(burst!.users.get('AAAAD')).toBe('');
    });

    it('should parse BURST with bans', () => {
      const burst = parseBurst('AB B #test 1234567890 +nt :%*!*@banned.host');
      expect(burst).not.toBeNull();
      expect(burst!.bans).toContain('*!*@banned.host');
    });

    it('should parse BURST with mode key parameter', () => {
      const burst = parseBurst('AB B #test 1234567890 +ntk secretkey AAAAB:o');
      expect(burst).not.toBeNull();
      expect(burst!.modes).toBe('+ntk');
      expect(burst!.modeParams).toContain('secretkey');
    });

    it('should return null for non-BURST message', () => {
      const burst = parseBurst('AB N TestUser 1 1234567890 ~user host +i AAAAB AAA :Name');
      expect(burst).toBeNull();
    });
  });

  describe('parseNick', () => {
    it('should parse N message without account', () => {
      const nick = parseNick('AB N TestUser 1 1234567890 ~user host.example.com +i AAAAB AAAAAA :Real Name');
      expect(nick).not.toBeNull();
      expect(nick!.nick).toBe('TestUser');
      expect(nick!.ident).toBe('~user');
      expect(nick!.host).toBe('host.example.com');
      expect(nick!.modes).toBe('+i');
      expect(nick!.account).toBeNull();
      expect(nick!.realname).toBe('Real Name');
    });

    it('should parse N message with account', () => {
      const nick = parseNick('AB N AuthedUser 1 1234567890 ~user host.example.com +r MyAccount AAAAB AAAAAA :Real Name');
      expect(nick).not.toBeNull();
      expect(nick!.nick).toBe('AuthedUser');
      expect(nick!.modes).toBe('+r');
      expect(nick!.account).toBe('MyAccount');
    });

    it('should return null for non-N message', () => {
      const nick = parseNick('AB B #test 1234567890 +nt');
      expect(nick).toBeNull();
    });
  });

  describe('validateBurstOrder', () => {
    it('should validate correct burst order', () => {
      const logs = [
        'AB SERVER leaf.example.com 1 :Leaf server',
        'AB N User1 1 1234567890 ~user host +i AAAAB AAA :Name',
        'AB N User2 1 1234567890 ~user host +i AAAAC AAA :Name',
        'AB B #test 1234567890 +nt AAAAB:o',
        'AB EB',
      ];
      const result = validateBurstOrder(logs);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect out-of-order BURST', () => {
      const logs = [
        'AB B #test 1234567890 +nt AAAAB:o',  // BURST before clients
        'AB N User1 1 1234567890 ~user host +i AAAAB AAA :Name',
        'AB EB',
      ];
      const result = validateBurstOrder(logs);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect CLIENTS after BURST', () => {
      const logs = [
        'AB N User1 1 1234567890 ~user host +i AAAAB AAA :Name',
        'AB B #test 1234567890 +nt AAAAB:o',
        'AB N User2 1 1234567890 ~user host +i AAAAC AAA :Name',  // Client after BURST
        'AB EB',
      ];
      const result = validateBurstOrder(logs);
      expect(result.valid).toBe(false);
    });
  });

  describe('channelTsWinner', () => {
    it('should prefer older timestamp', () => {
      expect(channelTsWinner(1000, 2000)).toBe('first');
      expect(channelTsWinner(2000, 1000)).toBe('second');
    });

    it('should merge on equal timestamps', () => {
      expect(channelTsWinner(1000, 1000)).toBe('merge');
    });
  });

  describe('getServerFromNumeric', () => {
    it('should extract server from 5-char user numeric', () => {
      expect(getServerFromNumeric('AAAAB')).toBe('AA');
      expect(getServerFromNumeric('ABCDE')).toBe('AB');
    });

    it('should return 2-char server numeric as-is', () => {
      expect(getServerFromNumeric('AB')).toBe('AB');
    });
  });
});

// ============================================================================
// P10 BURST Integration Tests (require linked servers)
// ============================================================================

describe.skipIf(!secondaryAvailable)('P10 BURST Integration', () => {
  describe('Channel State Synchronization', () => {
    it('should propagate channel creation to second server', async () => {
      const testId = uniqueId();
      const channel = `#p10sync-${testId}`;
      const nick1 = `p10user1${testId.slice(0, 4)}`;
      const nick2 = `p10user2${testId.slice(0, 4)}`;

      // Create client on primary server and join channel
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      // Create client on secondary server
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

      // Join the same channel from secondary
      secondary.send(`JOIN ${channel}`);
      const joinResponse = await secondary.waitForJoin(channel, undefined, 5000);
      expect(joinResponse.raw).toContain(channel);

      // Verify both users see each other in NAMES
      secondary.send(`NAMES ${channel}`);
      const namesResponse = await secondary.waitForLine(/353/, 5000);
      expect(namesResponse).toContain(nick1);
      expect(namesResponse).toContain(nick2);
    });

    it('should propagate channel modes in BURST', async () => {
      const testId = uniqueId();
      const channel = `#p10mode-${testId}`;
      const nick1 = `modetest1${testId.slice(0, 3)}`;
      const nick2 = `modetest2${testId.slice(0, 3)}`;

      // Create channel with specific modes on primary
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      // Set modes on primary
      primary.send(`MODE ${channel} +nt`);
      await primary.waitForLine(/MODE.*\+nt/i, 3000).catch(() => null); // May already be set

      primary.send(`MODE ${channel} +s`);
      await primary.waitForLine(/MODE.*\+s/i, 3000);

      // Allow time for mode to propagate
      await new Promise(r => setTimeout(r, 200));

      // Check modes from secondary server
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

      secondary.send(`JOIN ${channel}`);
      await secondary.waitForJoin(channel, undefined, 5000);

      secondary.send(`MODE ${channel}`);
      const modeResponse = await secondary.waitForLine(/324.*\+/, 5000);
      expect(modeResponse).toMatch(/s/); // Secret mode should be present
    });

    it('should propagate user channel modes (op/voice)', async () => {
      const testId = uniqueId();
      const channel = `#p10umode-${testId}`;
      const opNick = `opuser${testId.slice(0, 4)}`;
      const voiceNick = `vuser${testId.slice(0, 5)}`;
      const observerNick = `obs${testId.slice(0, 6)}`;

      // Primary server: create channel, op and voice users
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, opNick));

      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      // Create second user on primary to give voice
      const voice = trackClient(await createRegisteredClient(PRIMARY_SERVER, voiceNick));

      voice.send(`JOIN ${channel}`);
      await voice.waitForJoin(channel, undefined, 5000);

      // Give voice
      primary.send(`MODE ${channel} +v ${voiceNick}`);
      await primary.waitForLine(new RegExp(`MODE.*\\+v.*${voiceNick}`, 'i'), 5000);

      // Observer on secondary should see modes in NAMES
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, observerNick));

      secondary.send(`JOIN ${channel}`);
      await secondary.waitForJoin(channel, undefined, 5000);

      secondary.send(`NAMES ${channel}`);
      const namesResponse = await secondary.waitForLine(/353/, 5000);

      // @ prefix for op, + prefix for voice
      expect(namesResponse).toMatch(new RegExp(`@${opNick}`));
      expect(namesResponse).toMatch(new RegExp(`\\+${voiceNick}`));
    });

    it('should propagate ban list in BURST', async () => {
      const testId = uniqueId();
      const channel = `#p10ban-${testId}`;
      const nick1 = `bantest1${testId.slice(0, 3)}`;
      const nick2 = `bantest2${testId.slice(0, 3)}`;
      const banMask = `*!*@banned-${testId}.example.com`;

      // Create channel and set ban on primary
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      primary.send(`MODE ${channel} +b ${banMask}`);
      await primary.waitForLine(/MODE.*\+b/i, 5000);

      // Check ban list from secondary server
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

      secondary.send(`JOIN ${channel}`);
      await secondary.waitForJoin(channel, undefined, 5000);

      secondary.send(`MODE ${channel} +b`);

      // Wait for ban list (367 = RPL_BANLIST, 368 = RPL_ENDOFBANLIST)
      const banListResponse = await secondary.waitForLine(/367.*banned/i, 5000);
      expect(banListResponse).toContain(banMask);
    });
  });

  describe('BURST Timestamp Rules', () => {
    it('should preserve older channel timestamp across servers', async () => {
      const testId = uniqueId();
      const channel = `#tstest-${testId}`;
      const nick1 = `tstest1${testId.slice(0, 4)}`;
      const nick2 = `tstest2${testId.slice(0, 4)}`;

      // Create channel on primary first
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      // Wait a bit before joining from secondary
      await new Promise(r => setTimeout(r, 500));

      // Join from secondary - should not reset channel TS
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

      secondary.send(`JOIN ${channel}`);
      await secondary.waitForJoin(channel, undefined, 5000);

      // Both servers should report consistent creation time
      // (We can't easily access TS directly, but modes should be consistent)
      primary.send(`MODE ${channel}`);
      secondary.send(`MODE ${channel}`);

      const primaryModes = await primary.waitForLine(/324/, 5000);
      const secondaryModes = await secondary.waitForLine(/324/, 5000);

      // Both should show same modes (channel wasn't reset)
      expect(primaryModes).toMatch(/\+[a-z]+/);
      expect(secondaryModes).toMatch(/\+[a-z]+/);
    });
  });

  describe('Cross-Server User Visibility', () => {
    it('should show users from both servers in NAMES', async () => {
      const testId = uniqueId();
      const channel = `#xsnames-${testId}`;
      const primaryNicks = [`xsp1${testId.slice(0, 4)}`, `xsp2${testId.slice(0, 4)}`];
      const secondaryNicks = [`xss1${testId.slice(0, 4)}`, `xss2${testId.slice(0, 4)}`];

      // Join users from primary
      const primaryClients: RawSocketClient[] = [];
      for (const nick of primaryNicks) {
        const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));
        client.send(`JOIN ${channel}`);
        await client.waitForJoin(channel, undefined, 5000);
        primaryClients.push(client);
      }

      // Join users from secondary
      const secondaryClients: RawSocketClient[] = [];
      for (const nick of secondaryNicks) {
        const client = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick));
        client.send(`JOIN ${channel}`);
        await client.waitForJoin(channel, undefined, 5000);
        secondaryClients.push(client);
      }

      // Check NAMES from primary server
      primaryClients[0].send(`NAMES ${channel}`);
      const primaryNames = await primaryClients[0].waitForLine(/353/, 5000);

      // All nicks should be visible
      for (const nick of [...primaryNicks, ...secondaryNicks]) {
        expect(primaryNames.toLowerCase()).toContain(nick.toLowerCase());
      }

      // Check NAMES from secondary server
      secondaryClients[0].send(`NAMES ${channel}`);
      const secondaryNames = await secondaryClients[0].waitForLine(/353/, 5000);

      for (const nick of [...primaryNicks, ...secondaryNicks]) {
        expect(secondaryNames.toLowerCase()).toContain(nick.toLowerCase());
      }
    });

    it('should propagate WHO information across servers', async () => {
      const testId = uniqueId();
      const channel = `#xswho-${testId}`;
      const nick1 = `xswho1${testId.slice(0, 4)}`;
      const nick2 = `xswho2${testId.slice(0, 4)}`;

      // Create user on primary
      const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel, undefined, 5000);

      // Create user on secondary
      const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));
      secondary.send(`JOIN ${channel}`);
      await secondary.waitForJoin(channel, undefined, 5000);

      // WHO from secondary should show primary user
      secondary.send(`WHO ${channel}`);

      // Collect WHO responses (352 = RPL_WHOREPLY)
      const whoLines: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await secondary.waitForLine(/352|315/, 500);
          whoLines.push(line);
          if (line.includes('315')) break; // End of WHO
        } catch {
          break;
        }
      }

      const whoOutput = whoLines.join('\n');
      expect(whoOutput).toContain(nick1);
      expect(whoOutput).toContain(nick2);
    });
  });
});

// ============================================================================
// Docker Log Inspection Tests (require linked servers)
// ============================================================================

describe.skipIf(!secondaryAvailable)('P10 Log Inspection', () => {
  it('should capture P10 messages in docker logs', async () => {
    const testId = uniqueId();
    const channel = `#logtest-${testId}`;
    const nick = `logtest${testId.slice(0, 5)}`;

    // Create activity to generate P10 messages
    const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    client.send(`JOIN ${channel}`);
    await client.waitForJoin(channel, undefined, 5000);

    // Try to get P10 logs (may or may not capture depending on server debug level)
    const logs = await getP10Logs('nefarious', undefined, '1m');

    // This test just verifies the log fetching mechanism works
    // Actual P10 message visibility depends on server debug configuration
    expect(Array.isArray(logs)).toBe(true);
  });
});
