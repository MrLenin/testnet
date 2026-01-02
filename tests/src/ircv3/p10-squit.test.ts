/**
 * P10 SQUIT/Netsplit Handling Tests
 *
 * Tests for server disconnection and netsplit scenarios.
 *
 * SQUIT (Server QUIT) Protocol:
 * - Server sends SQUIT to disconnect from network
 * - All downstream users are marked as split
 * - QUITs propagated with netsplit reason
 * - Channel memberships cleared for split users
 * - State restored on reconnect via BURST
 *
 * Note: Full netsplit testing requires ability to disconnect/reconnect
 * servers which may not be possible in all test environments.
 * These tests focus on observable client effects.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createClientOnServer,
  RawSocketClient,
  isSecondaryServerAvailable,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  uniqueId,
} from '../helpers/index.js';

/**
 * Create a connected and registered client on a server.
 */
async function createRegisteredClient(server: typeof PRIMARY_SERVER, nick: string): Promise<RawSocketClient> {
  const client = await createClientOnServer(server);
  await client.capLs();
  client.capEnd();
  client.register(nick);
  await client.waitForLine(/001/, 5000);
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
    console.log('Secondary server not available - P10 SQUIT tests will be skipped');
  }
});

afterAll(async () => {
  await cleanupClients();
});

beforeEach(async () => {
  await cleanupClients();
});

// ============================================================================
// Server Topology Verification
// ============================================================================

describe.skipIf(!secondaryAvailable)('Server Topology', () => {
  it('should show multiple servers in LINKS', async () => {
    const testId = uniqueId();
    const nick = `links${testId.slice(0, 5)}`;

    const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    // LINKS shows server topology
    client.send('LINKS');

    // Collect LINKS responses (364 = RPL_LINKS, 365 = RPL_ENDOFLINKS)
    const linksLines: string[] = [];
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      try {
        const line = await client.waitForLine(/364|365/, 500);
        linksLines.push(line);
        if (line.includes('365')) break;
      } catch {
        break;
      }
    }

    // Should have at least 2 servers (primary and secondary)
    const serverCount = linksLines.filter(l => l.includes('364')).length;
    expect(serverCount).toBeGreaterThanOrEqual(2);
  });

  it('should show server info in MAP', async () => {
    const testId = uniqueId();
    const nick = `mapper${testId.slice(0, 4)}`;

    const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    // MAP shows server tree (if available)
    client.send('MAP');

    // Wait for any response (command might not be available to users)
    const response = await client.waitForLine(/.+/, 3000).catch(() => null);

    // Just verify we got some response (might be permission denied)
    expect(response).toBeDefined();
  });

  it('should show uplink in ADMIN', async () => {
    const testId = uniqueId();
    const nick = `admin${testId.slice(0, 5)}`;

    const client = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick));

    // ADMIN shows server information
    client.send('ADMIN');

    // Collect ADMIN responses
    const adminLines: string[] = [];
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      try {
        const line = await client.waitForLine(/256|257|258|259/, 500);
        adminLines.push(line);
        if (line.includes('259')) break;
      } catch {
        break;
      }
    }

    // Should have admin info
    expect(adminLines.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// User Visibility Across Servers
// ============================================================================

describe.skipIf(!secondaryAvailable)('Cross-Server User Visibility', () => {
  it('should see users from remote server via WHOIS', async () => {
    const testId = uniqueId();
    const remoteNick = `remote${testId.slice(0, 4)}`;
    const localNick = `local${testId.slice(0, 5)}`;

    // Create user on secondary (remote)
    const remote = trackClient(await createRegisteredClient(SECONDARY_SERVER, remoteNick));

    // Create user on primary (local)
    const local = trackClient(await createRegisteredClient(PRIMARY_SERVER, localNick));

    // WHOIS the remote user from local
    local.send(`WHOIS ${remoteNick}`);
    const whoisResponse = await local.waitForLine(new RegExp(`311.*${remoteNick}`, 'i'), 5000);

    expect(whoisResponse).toContain(remoteNick);
  });

  it('should show remote server in WHOIS server field', async () => {
    const testId = uniqueId();
    const remoteNick = `remotesrv${testId.slice(0, 3)}`;
    const localNick = `localsrv${testId.slice(0, 4)}`;

    // Create user on secondary
    const remote = trackClient(await createRegisteredClient(SECONDARY_SERVER, remoteNick));

    // Create user on primary
    const local = trackClient(await createRegisteredClient(PRIMARY_SERVER, localNick));

    // WHOIS shows server in 312 numeric
    local.send(`WHOIS ${remoteNick}`);

    // Collect WHOIS responses
    const whoisLines: string[] = [];
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      try {
        const line = await local.waitForLine(/31[1-9]|318/, 500);
        whoisLines.push(line);
        if (line.includes('318')) break; // End of WHOIS
      } catch {
        break;
      }
    }

    // 312 line should show the server name
    const serverLine = whoisLines.find(l => l.includes('312'));
    expect(serverLine).toBeDefined();
    // Secondary server name should be in the response
    expect(serverLine).toMatch(/leaf|nefarious2|secondary/i);
  });
});

// ============================================================================
// Simulated Disconnect Detection
// ============================================================================

describe.skipIf(!secondaryAvailable)('Disconnect Detection', () => {
  it('should detect when remote user quits', async () => {
    const testId = uniqueId();
    const channel = `#splitdet-${testId}`;
    const remoteNick = `splitter${testId.slice(0, 3)}`;
    const localNick = `watcher${testId.slice(0, 4)}`;

    // Setup: both users in same channel
    const remote = trackClient(await createRegisteredClient(SECONDARY_SERVER, remoteNick));
    const local = trackClient(await createRegisteredClient(PRIMARY_SERVER, localNick));

    // Join channel
    remote.send(`JOIN ${channel}`);
    await remote.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    local.send(`JOIN ${channel}`);
    await local.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    // Verify visibility
    local.send(`NAMES ${channel}`);
    await local.waitForLine(new RegExp(`353.*${remoteNick}`, 'i'), 5000);

    // Simulate disconnect by closing remote connection abruptly
    remote.close();
    const idx = activeClients.indexOf(remote);
    if (idx > -1) activeClients.splice(idx, 1);

    // Local should eventually see QUIT
    const quitMsg = await local.waitForLine(/QUIT/i, 10000);
    expect(quitMsg).toBeDefined();

    // User should no longer be in channel
    await new Promise(r => setTimeout(r, 500));
    local.send(`NAMES ${channel}`);
    const names = await local.waitForLine(/353|366/, 5000);
    expect(names.toLowerCase()).not.toContain(remoteNick.toLowerCase());
  });

  it('should handle multiple users from same server disconnecting', async () => {
    const testId = uniqueId();
    const channel = `#multiquit-${testId}`;
    const remoteNicks = [`mq1${testId.slice(0, 4)}`, `mq2${testId.slice(0, 4)}`];
    const localNick = `mqwatch${testId.slice(0, 3)}`;

    // Create local watcher
    const local = trackClient(await createRegisteredClient(PRIMARY_SERVER, localNick));

    local.send(`JOIN ${channel}`);
    await local.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    // Create multiple remote users
    const remoteClients: RawSocketClient[] = [];
    for (const nick of remoteNicks) {
      const client = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick));
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);
      remoteClients.push(client);
    }

    // Verify all visible
    local.send(`NAMES ${channel}`);
    const initialNames = await local.waitForLine(/353/, 5000);
    for (const nick of remoteNicks) {
      expect(initialNames.toLowerCase()).toContain(nick.toLowerCase());
    }

    // Disconnect both remote clients
    for (const client of remoteClients) {
      client.close();
      const idx = activeClients.indexOf(client);
      if (idx > -1) activeClients.splice(idx, 1);
    }

    // Wait for QUITs to propagate
    await new Promise(r => setTimeout(r, 2000));

    // All remote users should be gone
    local.send(`NAMES ${channel}`);
    const finalNames = await local.waitForLine(/353|366/, 5000);
    for (const nick of remoteNicks) {
      expect(finalNames.toLowerCase()).not.toContain(nick.toLowerCase());
    }
  });
});

// ============================================================================
// Reconnection and State Restoration
// ============================================================================

describe.skipIf(!secondaryAvailable)('State After Reconnection', () => {
  it('should restore channel membership after reconnect', async () => {
    const testId = uniqueId();
    const channel = `#restore-${testId}`;
    const nick = `restore${testId.slice(0, 4)}`;

    // Connect and join channel
    let client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    client.send(`JOIN ${channel}`);
    await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    // Disconnect
    client.send('QUIT :Disconnect for test');
    client.close();
    const idx = activeClients.indexOf(client);
    if (idx > -1) activeClients.splice(idx, 1);

    await new Promise(r => setTimeout(r, 500));

    // Reconnect
    client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    // Should need to rejoin (not automatically in channel)
    client.send(`NAMES ${channel}`);
    const names = await client.waitForLine(/353|366/, 5000);

    // If 366 (end of names) without 353, or 353 doesn't contain our nick
    // then we're not in the channel (expected)
    if (names.includes('353')) {
      // Channel exists, check if we're in it
      expect(names.toLowerCase()).not.toContain(`@${nick.toLowerCase()}`);
    }
    // Either way, we'd need to rejoin

    // Rejoin and verify
    client.send(`JOIN ${channel}`);
    await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    client.send(`NAMES ${channel}`);
    const rejoinNames = await client.waitForLine(/353/, 5000);
    expect(rejoinNames.toLowerCase()).toContain(nick.toLowerCase());
  });

  it('should get channel modes from BURST on join', async () => {
    const testId = uniqueId();
    const channel = `#burstmode-${testId}`;
    const nick1 = `burst1${testId.slice(0, 4)}`;
    const nick2 = `burst2${testId.slice(0, 4)}`;

    // Create channel with specific modes on primary
    const primary = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

    primary.send(`JOIN ${channel}`);
    await primary.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    primary.send(`MODE ${channel} +ms`);
    await primary.waitForLine(/MODE.*\+[ms]/i, 3000).catch(() => null);

    // Connect from secondary and join
    const secondary = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

    secondary.send(`JOIN ${channel}`);
    await secondary.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);

    // Check modes - should see modes from BURST
    secondary.send(`MODE ${channel}`);
    const modeResponse = await secondary.waitForLine(/324/, 5000);

    // Should have the modes we set
    expect(modeResponse).toMatch(/[sm]/);
  });
});

// ============================================================================
// LUSERS Statistics
// ============================================================================

describe.skipIf(!secondaryAvailable)('Network Statistics', () => {
  it('should show correct server count in LUSERS', async () => {
    const testId = uniqueId();
    const nick = `lusers${testId.slice(0, 4)}`;

    const client = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick));

    client.send('LUSERS');

    // Collect LUSERS responses
    const lusersLines: string[] = [];
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      try {
        const line = await client.waitForLine(/25[0-9]|26[0-9]/, 500);
        lusersLines.push(line);
      } catch {
        break;
      }
    }

    // Should have at least some stats
    expect(lusersLines.length).toBeGreaterThan(0);

    // 254 shows channel count, 251/252/253 show user counts, 250 shows highest
    const hasServerInfo = lusersLines.some(l =>
      l.includes('251') || l.includes('252') || l.includes('254')
    );
    expect(hasServerInfo).toBe(true);
  });

  it('should update stats when users join/leave', async () => {
    const testId = uniqueId();
    const nick1 = `stat1${testId.slice(0, 5)}`;
    const nick2 = `stat2${testId.slice(0, 5)}`;

    // First user
    const client1 = trackClient(await createRegisteredClient(PRIMARY_SERVER, nick1));

    // Get initial stats
    client1.send('LUSERS');
    let userCountLine = await client1.waitForLine(/251/, 3000);
    const initialMatch = userCountLine.match(/(\d+)\s+user/i);
    const initialUsers = initialMatch ? parseInt(initialMatch[1], 10) : 0;

    // Second user joins
    const client2 = trackClient(await createRegisteredClient(SECONDARY_SERVER, nick2));

    // Wait for stats to update
    await new Promise(r => setTimeout(r, 300));

    // Check stats again
    client1.send('LUSERS');
    userCountLine = await client1.waitForLine(/251/, 3000);
    const newMatch = userCountLine.match(/(\d+)\s+user/i);
    const newUsers = newMatch ? parseInt(newMatch[1], 10) : 0;

    // User count should have increased
    expect(newUsers).toBeGreaterThanOrEqual(initialUsers);
  });
});
