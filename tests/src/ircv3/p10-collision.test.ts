/**
 * P10 Nick/Server Collision Tests
 *
 * Tests for P10 collision handling and TS rules.
 *
 * P10 Nick Collision Rules:
 * - If user@host differs: older TS wins (newer killed)
 * - If user@host matches: newer TS wins (older killed, likely reconnect)
 * - If TS equal: both killed
 *
 * P10 Numeric Validation:
 * - Server numerics: 0-4095 (2 base64 chars)
 * - User numerics: 0-262143 (3 base64 chars within server space)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createClientOnServer,
  RawSocketClient,
  isSecondaryServerAvailable,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  uniqueId,
  // P10 helpers
  nickCollisionWinner,
  getServerFromNumeric,
  isFromServer,
  decodeServerNumeric,
  decodeUserNumeric,
  encodeServerNumeric,
  encodeUserNumeric,
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
    console.log('Secondary server not available - P10 collision tests will be skipped');
  }
});

afterAll(async () => {
  await cleanupClients();
});

beforeEach(async () => {
  await cleanupClients();
});

// ============================================================================
// Nick Collision Winner Logic Unit Tests
// ============================================================================

describe('Nick Collision Winner Logic', () => {
  describe('Different user@host', () => {
    it('should prefer older TS when user@host differs', () => {
      // Different users, older wins
      const result = nickCollisionWinner(
        1000, 'user1@host1.example.com',
        2000, 'user2@host2.example.com'
      );
      expect(result).toBe('first'); // First has older TS, so first wins
    });

    it('should kill newer when user@host differs', () => {
      const result = nickCollisionWinner(
        2000, 'user1@host1.example.com',
        1000, 'user2@host2.example.com'
      );
      expect(result).toBe('second'); // Second has older TS, so second wins
    });
  });

  describe('Same user@host (reconnect scenario)', () => {
    it('should prefer newer TS for reconnect', () => {
      // Same user reconnecting - newer wins (more recent connection)
      const result = nickCollisionWinner(
        2000, 'user@host.example.com',
        1000, 'user@host.example.com'
      );
      expect(result).toBe('first'); // First has newer TS
    });

    it('should kill older connection on reconnect', () => {
      const result = nickCollisionWinner(
        1000, 'user@host.example.com',
        2000, 'user@host.example.com'
      );
      expect(result).toBe('second'); // Second has newer TS
    });

    it('should be case-insensitive for user@host comparison', () => {
      const result = nickCollisionWinner(
        2000, 'User@Host.Example.COM',
        1000, 'user@host.example.com'
      );
      expect(result).toBe('first'); // Same user@host, newer wins
    });
  });

  describe('Equal timestamps', () => {
    it('should kill both when TS is equal', () => {
      const result = nickCollisionWinner(
        1000, 'user1@host1.example.com',
        1000, 'user2@host2.example.com'
      );
      expect(result).toBe('both');
    });

    it('should kill both on equal TS even with same user@host', () => {
      const result = nickCollisionWinner(
        1000, 'user@host.example.com',
        1000, 'user@host.example.com'
      );
      expect(result).toBe('both');
    });
  });
});

// ============================================================================
// Numeric Encoding/Decoding Unit Tests
// ============================================================================

describe('P10 Numeric Encoding', () => {
  describe('Server Numerics (2 chars)', () => {
    it('should decode server numeric correctly', () => {
      expect(decodeServerNumeric('AA')).toBe(0);
      expect(decodeServerNumeric('AB')).toBe(1);
      expect(decodeServerNumeric('BA')).toBe(64);
      expect(decodeServerNumeric(']]')).toBe(4095);
    });

    it('should encode server numeric correctly', () => {
      expect(encodeServerNumeric(0)).toBe('AA');
      expect(encodeServerNumeric(1)).toBe('AB');
      expect(encodeServerNumeric(64)).toBe('BA');
      expect(encodeServerNumeric(4095)).toBe(']]');
    });

    it('should round-trip server numerics', () => {
      for (const val of [0, 1, 63, 64, 100, 1000, 4095]) {
        expect(decodeServerNumeric(encodeServerNumeric(val))).toBe(val);
      }
    });
  });

  describe('User Numerics (3 chars)', () => {
    it('should decode user numeric correctly', () => {
      expect(decodeUserNumeric('AAA')).toBe(0);
      expect(decodeUserNumeric('AAB')).toBe(1);
      expect(decodeUserNumeric('ABA')).toBe(64);
      expect(decodeUserNumeric(']]]')).toBe(262143);
    });

    it('should encode user numeric correctly', () => {
      expect(encodeUserNumeric(0)).toBe('AAA');
      expect(encodeUserNumeric(1)).toBe('AAB');
      expect(encodeUserNumeric(64)).toBe('ABA');
      expect(encodeUserNumeric(262143)).toBe(']]]');
    });

    it('should round-trip user numerics', () => {
      for (const val of [0, 1, 63, 64, 1000, 10000, 262143]) {
        expect(decodeUserNumeric(encodeUserNumeric(val))).toBe(val);
      }
    });
  });

  describe('Full Numerics (5 chars = server + user)', () => {
    it('should extract server from full numeric', () => {
      expect(getServerFromNumeric('AAAAB')).toBe('AA');
      expect(getServerFromNumeric('ABCDE')).toBe('AB');
      expect(getServerFromNumeric(']]AAA')).toBe(']]');
    });

    it('should detect if numeric belongs to server', () => {
      expect(isFromServer('AAAAB', 'AA')).toBe(true);
      expect(isFromServer('ABAAB', 'AA')).toBe(false);
      expect(isFromServer('ABAAB', 'AB')).toBe(true);
    });
  });

  describe('Numeric Validity', () => {
    it('should handle boundary values for server numeric', () => {
      // Valid range: 0-4095
      expect(encodeServerNumeric(0)).toBeDefined();
      expect(encodeServerNumeric(4095)).toBeDefined();
    });

    it('should handle boundary values for user numeric', () => {
      // Valid range: 0-262143
      expect(encodeUserNumeric(0)).toBeDefined();
      expect(encodeUserNumeric(262143)).toBeDefined();
    });
  });
});

// ============================================================================
// Nick Collision Integration Tests (require linked servers)
// ============================================================================

describe.skipIf(!secondaryAvailable)('Nick Collision Handling', () => {
  it('should kill duplicate nick on different servers', async () => {
    const testId = uniqueId();
    const duplicateNick = `dupnick${testId.slice(0, 4)}`;

    // Connect first user on primary
    const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, duplicateNick));

    // Track if primary gets killed via buffer inspection
    let primaryKilled = false;

    // Try to connect second user with same nick on secondary
    // This should trigger nick collision
    let secondaryConnected = false;
    let secondaryKilled = false;

    try {
      // This will throw if registration fails due to nick collision
      const secondary = await createRegisteredClient(SECONDARY_SERVER, duplicateNick);
      secondaryConnected = true;
      trackClient(secondary);
    } catch {
      secondaryKilled = true;
    }

    // Wait a bit for collision propagation
    await new Promise(r => setTimeout(r, 500));

    // At least one should be killed or rejected
    // (The exact behavior depends on TS comparison)
    const collisionHandled = primaryKilled || secondaryKilled || !secondaryConnected;
    expect(collisionHandled).toBe(true);
  });

  it('should allow different nicks with same prefix', async () => {
    const testId = uniqueId();
    const nick1 = `user${testId.slice(0, 4)}A`;
    const nick2 = `user${testId.slice(0, 4)}B`;

    // These are different nicks, should both connect fine
    const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));
    const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

    // Both should be connected
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();

    // Verify by checking each can see the other
    const channel = `#colltest-${testId}`;
    primary.send(`JOIN ${channel}`);
    await primary.waitForJoin(channel, undefined, 5000);

    secondary.send(`JOIN ${channel}`);
    await secondary.waitForJoin(channel, undefined, 5000);

    primary.send(`NAMES ${channel}`);
    const names = await primary.waitForLine(/353/, 5000);
    expect(names).toContain(nick1);
    expect(names).toContain(nick2);
  });

  it('should handle rapid nick changes without collision', async () => {
    const testId = uniqueId();
    const initialNick = `rapid${testId.slice(0, 4)}`;
    const newNick = `changed${testId.slice(0, 3)}`;

    const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, initialNick));

    // Change nick rapidly
    client.send(`NICK ${newNick}`);
    const nickResponse = await client.waitForLine(/NICK/i, 5000);
    expect(nickResponse.toLowerCase()).toContain(newNick.toLowerCase());

    // Verify new nick works
    client.send('WHOIS ' + newNick);
    const whoisResponse = await client.waitForLine(/311|401/, 5000);
    expect(whoisResponse).toContain(newNick);
  });
});

// ============================================================================
// Cross-Server Nick Change Propagation
// ============================================================================

describe.skipIf(!secondaryAvailable)('Nick Change Propagation', () => {
  it('should propagate nick change to other server', async () => {
    const testId = uniqueId();
    const channel = `#nickprop-${testId}`;
    const nick1 = `nickp1${testId.slice(0, 4)}`;
    const nick1New = `newname${testId.slice(0, 3)}`;
    const nick2 = `nickp2${testId.slice(0, 4)}`;

    // Setup: two users in same channel on different servers
    const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));
    const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

    // Join channel on both
    primary.send(`JOIN ${channel}`);
    await primary.waitForJoin(channel, undefined, 5000);

    secondary.send(`JOIN ${channel}`);
    await secondary.waitForJoin(channel, undefined, 5000);

    // Wait for visibility
    secondary.send(`NAMES ${channel}`);
    await secondary.waitForLine(new RegExp(`353.*${nick1}`, 'i'), 5000);

    // Primary changes nick
    primary.send(`NICK ${nick1New}`);
    await primary.waitForLine(new RegExp(`NICK.*${nick1New}`, 'i'), 5000);

    // Secondary should see the nick change
    const nickChange = await secondary.waitForLine(new RegExp(`NICK.*${nick1New}`, 'i'), 5000);
    expect(nickChange.toLowerCase()).toContain(nick1New.toLowerCase());

    // Verify in NAMES
    secondary.send(`NAMES ${channel}`);
    const names = await secondary.waitForLine(/353/, 5000);
    expect(names.toLowerCase()).toContain(nick1New.toLowerCase());
    expect(names.toLowerCase()).not.toContain(nick1.toLowerCase());
  });

  it('should propagate QUIT to other server', async () => {
    const testId = uniqueId();
    const channel = `#quitprop-${testId}`;
    const nick1 = `quiter${testId.slice(0, 4)}`;
    const nick2 = `watcher${testId.slice(0, 3)}`;

    // Setup: two users in same channel
    const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));
    const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

    // Join channel on both
    primary.send(`JOIN ${channel}`);
    await primary.waitForJoin(channel, undefined, 5000);

    secondary.send(`JOIN ${channel}`);
    await secondary.waitForJoin(channel, undefined, 5000);

    // Wait for visibility
    secondary.send(`NAMES ${channel}`);
    await secondary.waitForLine(new RegExp(`353.*${nick1}`, 'i'), 5000);

    // Primary quits
    primary.send('QUIT :Test quit');

    // Remove from active clients since we're deliberately quitting
    const idx = activeClients.indexOf(primary);
    if (idx > -1) activeClients.splice(idx, 1);

    // Secondary should see the QUIT
    const quitMsg = await secondary.waitForLine(new RegExp(`QUIT.*${nick1}|:${nick1}.*QUIT`, 'i'), 5000);
    expect(quitMsg).toBeDefined();

    // User should no longer be in NAMES
    await new Promise(r => setTimeout(r, 200));
    secondary.send(`NAMES ${channel}`);
    const names = await secondary.waitForLine(/353|366/, 5000);
    expect(names.toLowerCase()).not.toContain(nick1.toLowerCase());
  });
});
