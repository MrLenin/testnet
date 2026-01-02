/**
 * P10 Protocol Helpers
 *
 * Higher-level utilities for testing P10 server-to-server protocol.
 * Includes log parsing, BURST validation, and protocol assertions.
 *
 * P10 Message Format:
 *   [source] <command> [params...] [:trailing]
 *
 * Key P10 Commands:
 *   SERVER - Server introduction
 *   N      - Client/nick introduction
 *   B      - Channel BURST
 *   EB     - End of BURST
 *   EA     - End of BURST Acknowledge
 *   SQ     - SQUIT (server quit)
 *   D      - KILL
 *   G      - PING/PONG
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { decodeServerNumeric, decodeUserNumeric, decodeFullNumeric } from './p10-utils.js';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed P10 message.
 */
export interface P10Message {
  /** Source numeric (server or user) */
  source: string | null;
  /** P10 command (N, B, SQ, etc.) */
  command: string;
  /** Command parameters */
  params: string[];
  /** Raw message line */
  raw: string;
}

/**
 * Parsed BURST (B) message for channel state.
 */
export interface P10Burst {
  /** Source server numeric */
  serverNumeric: string;
  /** Channel name */
  channel: string;
  /** Channel creation timestamp */
  timestamp: number;
  /** Channel modes (e.g., "+nt") */
  modes: string;
  /** Mode parameters (e.g., key, limit) */
  modeParams: string[];
  /** Users with their modes: { numeric: modes } */
  users: Map<string, string>;
  /** Ban list */
  bans: string[];
  /** Raw message */
  raw: string;
}

/**
 * Parsed N (nick) message for user introduction.
 */
export interface P10Nick {
  /** Source server numeric */
  serverNumeric: string;
  /** Nickname */
  nick: string;
  /** Hop count */
  hopcount: number;
  /** Timestamp */
  timestamp: number;
  /** Username/ident */
  ident: string;
  /** Hostname */
  host: string;
  /** User modes */
  modes: string;
  /** Account name (if authed) */
  account: string | null;
  /** User numeric (3 chars) */
  userNumeric: string;
  /** IP address (encoded) */
  ip: string;
  /** Real name/gecos */
  realname: string;
  /** Raw message */
  raw: string;
}

/**
 * Server topology node.
 */
export interface ServerNode {
  /** Server numeric */
  numeric: string;
  /** Server name */
  name: string;
  /** Uplink numeric (null for hub) */
  uplink: string | null;
  /** Downlink numerics */
  downlinks: string[];
}

// ============================================================================
// P10 Message Parsing
// ============================================================================

/**
 * Parse a P10 protocol message line.
 */
export function parseP10Message(line: string): P10Message {
  const raw = line.trim();
  const parts = raw.split(' ');

  let source: string | null = null;
  let commandIndex = 0;

  // First token might be source (if it's a server/user numeric)
  // P10 sources are 2 chars (server) or 5 chars (user)
  if (parts[0] && (parts[0].length === 2 || parts[0].length === 5)) {
    // Check if it looks like a P10 numeric (base64 chars only)
    if (/^[A-Za-z0-9\[\]]+$/.test(parts[0])) {
      source = parts[0];
      commandIndex = 1;
    }
  }

  const command = parts[commandIndex] || '';
  const paramParts = parts.slice(commandIndex + 1);

  // Handle trailing parameter (starts with :)
  const params: string[] = [];
  for (let i = 0; i < paramParts.length; i++) {
    if (paramParts[i].startsWith(':')) {
      // Rest of line is trailing
      params.push(paramParts.slice(i).join(' ').substring(1));
      break;
    }
    params.push(paramParts[i]);
  }

  return { source, command, params, raw };
}

/**
 * Parse a BURST (B) message.
 *
 * Format: <server> B <channel> <timestamp> [+modes [params]] [users] [:%bans]
 * Users: <numeric>[:modes][,<numeric>[:modes]...]
 */
export function parseBurst(line: string): P10Burst | null {
  const msg = parseP10Message(line);
  if (msg.command !== 'B') return null;

  const users = new Map<string, string>();
  const bans: string[] = [];
  let modes = '';
  let modeParams: string[] = [];

  const channel = msg.params[0];
  const timestamp = parseInt(msg.params[1], 10);

  let paramIndex = 2;

  // Parse modes if present
  if (msg.params[paramIndex]?.startsWith('+')) {
    modes = msg.params[paramIndex];
    paramIndex++;

    // Mode parameters (key, limit, etc.)
    while (paramIndex < msg.params.length) {
      const param = msg.params[paramIndex];
      if (param.includes(':') || param.startsWith('%')) break;
      modeParams.push(param);
      paramIndex++;
    }
  }

  // Parse users and bans
  for (let i = paramIndex; i < msg.params.length; i++) {
    const param = msg.params[i];

    if (param.startsWith('%')) {
      // Ban list: %*!*@banned.host %*!*@other.ban
      bans.push(...param.substring(1).split(' ').filter(b => b));
    } else if (param.includes(':') || /^[A-Za-z0-9\[\]]{3,5}/.test(param)) {
      // User list: AAAAB:o,AAAAC:v,AAAAD
      const userParts = param.split(',');
      for (const up of userParts) {
        const [numeric, userModes = ''] = up.split(':');
        if (numeric) {
          users.set(numeric, userModes);
        }
      }
    }
  }

  return {
    serverNumeric: msg.source || '',
    channel,
    timestamp,
    modes,
    modeParams,
    users,
    bans,
    raw: msg.raw,
  };
}

/**
 * Parse an N (nick) message.
 *
 * Format: <server> N <nick> <hopcount> <TS> <ident> <host> <modes> [<account>] <numeric> <IP> :<realname>
 */
export function parseNick(line: string): P10Nick | null {
  const msg = parseP10Message(line);
  if (msg.command !== 'N') return null;

  // Minimum params: nick, hopcount, ts, ident, host, modes, numeric, ip, realname
  if (msg.params.length < 8) return null;

  let account: string | null = null;
  let numericIndex = 6;
  let ipIndex = 7;

  // Check if there's an account field (modes contain +r or similar)
  const modes = msg.params[5];
  if (modes.includes('r') && msg.params.length > 8) {
    account = msg.params[6];
    numericIndex = 7;
    ipIndex = 8;
  }

  return {
    serverNumeric: msg.source || '',
    nick: msg.params[0],
    hopcount: parseInt(msg.params[1], 10),
    timestamp: parseInt(msg.params[2], 10),
    ident: msg.params[3],
    host: msg.params[4],
    modes,
    account,
    userNumeric: msg.params[numericIndex],
    ip: msg.params[ipIndex],
    realname: msg.params[msg.params.length - 1],
    raw: msg.raw,
  };
}

// ============================================================================
// Docker Log Parsing
// ============================================================================

/**
 * Get P10 messages from docker container logs.
 *
 * @param container - Container name (e.g., 'nefarious', 'nefarious2')
 * @param filter - Optional regex to filter messages
 * @param since - Time filter (e.g., '5m', '1h')
 */
export async function getP10Logs(
  container: string,
  filter?: RegExp,
  since = '5m'
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `docker logs --since ${since} ${container} 2>&1`
    );

    const lines = stdout.split('\n').filter(line => {
      // P10 messages are typically in debug output
      // Look for lines that look like P10 protocol
      if (!line.includes(' ')) return false;
      if (filter && !filter.test(line)) return false;
      return true;
    });

    return lines;
  } catch {
    return [];
  }
}

/**
 * Get BURST messages from logs.
 */
export async function getBurstLogs(container: string): Promise<P10Burst[]> {
  const logs = await getP10Logs(container, / B #/);
  return logs
    .map(line => parseBurst(line))
    .filter((b): b is P10Burst => b !== null);
}

/**
 * Get nick introductions from logs.
 */
export async function getNickLogs(container: string): Promise<P10Nick[]> {
  const logs = await getP10Logs(container, / N [^ ]+ \d+ \d+/);
  return logs
    .map(line => parseNick(line))
    .filter((n): n is P10Nick => n !== null);
}

// ============================================================================
// Burst Order Validation
// ============================================================================

/**
 * Burst order as specified in P10 protocol.
 */
export enum BurstPhase {
  SERVERS = 1,  // SERVER commands
  GLINES = 2,   // G-lines
  CLIENTS = 3,  // N (nick) commands
  CHANNELS = 4, // B (burst) commands
  END = 5,      // EB (end of burst)
}

/**
 * Validate that BURST messages follow correct P10 ordering.
 *
 * Correct order: SERVERS → GLINES → CLIENTS (N) → CHANNELS (B) → EB
 */
export function validateBurstOrder(logs: string[]): {
  valid: boolean;
  errors: string[];
  phases: BurstPhase[];
} {
  const errors: string[] = [];
  const phases: BurstPhase[] = [];
  let currentPhase = BurstPhase.SERVERS;

  for (const line of logs) {
    const msg = parseP10Message(line);

    let linePhase: BurstPhase | null = null;

    switch (msg.command) {
      case 'SERVER':
      case 'S':
        linePhase = BurstPhase.SERVERS;
        break;
      case 'GL':
        linePhase = BurstPhase.GLINES;
        break;
      case 'N':
        linePhase = BurstPhase.CLIENTS;
        break;
      case 'B':
        linePhase = BurstPhase.CHANNELS;
        break;
      case 'EB':
        linePhase = BurstPhase.END;
        break;
      default:
        // Other commands don't affect burst ordering
        continue;
    }

    if (linePhase !== null) {
      phases.push(linePhase);

      // Verify ordering
      if (linePhase < currentPhase) {
        errors.push(
          `Out of order: ${msg.command} (phase ${linePhase}) after phase ${currentPhase}`
        );
      }

      currentPhase = Math.max(currentPhase, linePhase);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    phases,
  };
}

// ============================================================================
// Timestamp Comparison (TS rules)
// ============================================================================

/**
 * Compare two timestamps for P10 TS rules.
 *
 * @returns 'older' if ts1 < ts2, 'newer' if ts1 > ts2, 'equal' if same
 */
export function compareTimestamps(
  ts1: number,
  ts2: number
): 'older' | 'newer' | 'equal' {
  if (ts1 < ts2) return 'older';
  if (ts1 > ts2) return 'newer';
  return 'equal';
}

/**
 * Determine TS winner for nick collision.
 *
 * P10 nick collision rules:
 * - If user@host differs: older TS wins (newer killed)
 * - If user@host matches: newer TS wins (older killed, likely reconnect)
 * - If TS equal: both killed
 */
export function nickCollisionWinner(
  ts1: number,
  userHost1: string,
  ts2: number,
  userHost2: string
): 'first' | 'second' | 'both' {
  if (ts1 === ts2) return 'both';

  const sameUserHost = userHost1.toLowerCase() === userHost2.toLowerCase();

  if (sameUserHost) {
    // Same user@host: newer wins (likely reconnect)
    return ts1 > ts2 ? 'first' : 'second';
  } else {
    // Different user@host: older wins
    return ts1 < ts2 ? 'first' : 'second';
  }
}

/**
 * Determine TS winner for channel mode conflict.
 *
 * P10 channel TS rules:
 * - Older TS wins completely (clear modes on newer side)
 * - Equal TS: merge modes
 */
export function channelTsWinner(
  ts1: number,
  ts2: number
): 'first' | 'second' | 'merge' {
  if (ts1 < ts2) return 'first';
  if (ts1 > ts2) return 'second';
  return 'merge';
}

// ============================================================================
// Numeric Utilities
// ============================================================================

/**
 * Extract server numeric from a full user numeric.
 */
export function getServerFromNumeric(fullNumeric: string): string {
  if (fullNumeric.length === 5) {
    return fullNumeric.substring(0, 2);
  }
  if (fullNumeric.length === 2) {
    return fullNumeric;
  }
  throw new Error(`Invalid numeric length: ${fullNumeric}`);
}

/**
 * Check if a numeric belongs to a specific server.
 */
export function isFromServer(numeric: string, serverNumeric: string): boolean {
  return getServerFromNumeric(numeric) === serverNumeric;
}

// ============================================================================
// Assertions
// ============================================================================

/**
 * Assert that a BURST contains expected users.
 */
export function assertBurstUsers(
  burst: P10Burst,
  expectedUsers: string[],
  message?: string
): void {
  const userNumerics = Array.from(burst.users.keys());

  for (const expected of expectedUsers) {
    const found = userNumerics.some(u => u.includes(expected) || expected.includes(u));
    if (!found) {
      throw new Error(
        message ||
          `Expected user ${expected} not found in BURST. Found: ${userNumerics.join(', ')}`
      );
    }
  }
}

/**
 * Assert that a BURST has expected modes.
 */
export function assertBurstModes(
  burst: P10Burst,
  expectedModes: string,
  message?: string
): void {
  // Normalize modes (remove leading +)
  const expected = expectedModes.replace(/^\+/, '');
  const actual = burst.modes.replace(/^\+/, '');

  for (const mode of expected) {
    if (!actual.includes(mode)) {
      throw new Error(
        message ||
          `Expected mode '${mode}' not found in BURST. Modes: ${burst.modes}`
      );
    }
  }
}

/**
 * Assert that a BURST has expected bans.
 */
export function assertBurstBans(
  burst: P10Burst,
  expectedBans: string[],
  message?: string
): void {
  for (const ban of expectedBans) {
    if (!burst.bans.includes(ban)) {
      throw new Error(
        message ||
          `Expected ban '${ban}' not found in BURST. Bans: ${burst.bans.join(', ')}`
      );
    }
  }
}
