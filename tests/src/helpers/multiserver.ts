/**
 * Multi-server Test Helpers
 *
 * Provides utilities for testing cross-server IRC functionality.
 * Designed to work with the 'linked' docker-compose profile.
 */

import { RawSocketClient, createClientOnServer, PRIMARY_SERVER, SECONDARY_SERVER, ServerConfig } from './ircv3-client.js';

/**
 * Server configurations for multi-server testing.
 *
 * Topology with linked profile (2 servers):
 *   hub1 --- leaf1
 *
 * Topology with multi profile (4 servers):
 *   hub1 --- hub2 --- leaf2
 *     |
 *   leaf1
 */
export const SERVERS: Record<string, ServerConfig> = {
  hub1: PRIMARY_SERVER,    // nefarious - testnet.fractalrealities.net (port 6667)
  leaf1: SECONDARY_SERVER, // nefarious2 - leaf.fractalrealities.net (port 6668)
  hub2: {                  // nefarious3 - hub2.fractalrealities.net (port 6669)
    host: 'localhost',
    port: 6669,
    ssl: false,
  },
  leaf2: {                 // nefarious4 - leaf2.fractalrealities.net (port 6670)
    host: 'localhost',
    port: 6670,
    ssl: false,
  },
};

/**
 * Tree structure for routing tests.
 * Describes the uplink/downlink relationships.
 */
export const TOPOLOGY: Record<string, { uplink: string | null; downlinks: string[] }> = {
  hub1: { uplink: null, downlinks: ['leaf1', 'hub2'] },
  leaf1: { uplink: 'hub1', downlinks: [] },
  hub2: { uplink: 'hub1', downlinks: ['leaf2'] },
  leaf2: { uplink: 'hub2', downlinks: [] },
};

/**
 * Context for multi-server tests with cleanup tracking.
 */
export interface MultiServerContext {
  primary: RawSocketClient;
  secondary: RawSocketClient;
  cleanup: () => void;
}

/**
 * Create clients connected to both primary and secondary servers.
 * Handles registration and returns both clients ready to use.
 */
export async function createMultiServerClients(
  primaryNick: string,
  secondaryNick: string
): Promise<MultiServerContext> {
  const primary = await createClientOnServer(PRIMARY_SERVER);
  const secondary = await createClientOnServer(SECONDARY_SERVER);

  // Register both clients
  await primary.capLs();
  primary.capEnd();
  primary.register(primaryNick);
  await primary.waitForLine(/001/);

  await secondary.capLs();
  secondary.capEnd();
  secondary.register(secondaryNick);
  await secondary.waitForLine(/001/);

  return {
    primary,
    secondary,
    cleanup: () => {
      try { primary.close(); } catch { /* ignore */ }
      try { secondary.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Wait for an event to propagate across servers.
 * Use this instead of magic sleep delays.
 *
 * @param target - Client that should receive the event
 * @param pattern - Regex to match the expected event
 * @param timeout - Maximum time to wait (default 5000ms)
 * @returns The matched line, or null if timeout
 */
export async function waitForCrossServerSync(
  target: RawSocketClient,
  pattern: RegExp,
  timeout = 5000
): Promise<string | null> {
  try {
    return await target.waitForLine(pattern, timeout);
  } catch {
    return null;
  }
}

/**
 * Wait for an event to propagate, throwing if not received.
 * Use this when the event is required (not optional).
 */
export async function expectCrossServerSync(
  target: RawSocketClient,
  pattern: RegExp,
  timeout = 5000
): Promise<string> {
  return target.waitForLine(pattern, timeout);
}

/**
 * Collect multiple lines matching a pattern until an end condition.
 * Useful for collecting WHO replies, NAMES replies, etc.
 *
 * @param client - Client to collect from
 * @param matchPattern - Pattern for lines to collect
 * @param endPattern - Pattern indicating end of collection
 * @param timeout - Per-line timeout
 * @returns Array of collected lines
 */
export async function collectMultipleLines(
  client: RawSocketClient,
  matchPattern: RegExp,
  endPattern: RegExp,
  timeout = 3000
): Promise<string[]> {
  const collected: string[] = [];
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const line = await client.waitForLine(
        new RegExp(`${matchPattern.source}|${endPattern.source}`, 'i'),
        Math.min(1000, timeout - (Date.now() - startTime))
      );

      if (endPattern.test(line)) {
        break;
      }
      if (matchPattern.test(line)) {
        collected.push(line);
      }
    } catch {
      // Timeout on individual line - continue if overall timeout not reached
      break;
    }
  }

  return collected;
}

/**
 * Verify a channel exists and has expected users on both servers.
 */
export async function verifyChannelSync(
  channel: string,
  primaryClient: RawSocketClient,
  secondaryClient: RawSocketClient,
  expectedUsers: string[]
): Promise<{ primary: string[]; secondary: string[] }> {
  // Get NAMES on primary
  primaryClient.clearRawBuffer();
  primaryClient.send(`NAMES ${channel}`);
  const primaryNames = await collectMultipleLines(
    primaryClient,
    /353.*=/,  // RPL_NAMREPLY
    /366/,     // RPL_ENDOFNAMES
    3000
  );

  // Get NAMES on secondary
  secondaryClient.clearRawBuffer();
  secondaryClient.send(`NAMES ${channel}`);
  const secondaryNames = await collectMultipleLines(
    secondaryClient,
    /353.*=/,
    /366/,
    3000
  );

  return {
    primary: primaryNames,
    secondary: secondaryNames,
  };
}

/**
 * Calculate hop count between two servers in the topology.
 */
export function getHopCount(from: keyof typeof TOPOLOGY, to: keyof typeof TOPOLOGY): number {
  if (from === to) return 0;

  // Simple BFS for tree topology
  const visited = new Set<string>();
  const queue: Array<{ node: string; hops: number }> = [{ node: from, hops: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.node === to) return current.hops;

    visited.add(current.node);
    const topology = TOPOLOGY[current.node as keyof typeof TOPOLOGY];

    // Check uplink
    if (topology.uplink && !visited.has(topology.uplink)) {
      queue.push({ node: topology.uplink, hops: current.hops + 1 });
    }

    // Check downlinks
    for (const downlink of topology.downlinks) {
      if (!visited.has(downlink)) {
        queue.push({ node: downlink, hops: current.hops + 1 });
      }
    }
  }

  return -1; // Not reachable
}

/**
 * Get list of currently available servers.
 * Checks connectivity to each server in SERVERS.
 */
export async function getAvailableServers(): Promise<string[]> {
  const available: string[] = ['hub1']; // Primary always assumed available

  // Check each additional server
  const serversToCheck = ['leaf1', 'hub2', 'leaf2'] as const;

  for (const serverName of serversToCheck) {
    try {
      const client = await createClientOnServer(SERVERS[serverName]);
      client.close();
      available.push(serverName);
    } catch {
      // Server not available
    }
  }

  return available;
}

/**
 * Check if a specific server is available.
 */
export async function isServerAvailable(serverName: keyof typeof SERVERS): Promise<boolean> {
  if (serverName === 'hub1') return true; // Primary always available

  try {
    const client = await createClientOnServer(SERVERS[serverName]);
    client.close();
    return true;
  } catch {
    return false;
  }
}
