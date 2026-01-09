/**
 * X3 Services Client Helper
 *
 * Provides utilities for testing X3 IRC services (AuthServ, ChanServ, OpServ).
 *
 * X3 Communication Pattern:
 *   Client → Service:  PRIVMSG <Service> :<command>
 *   Service → Client:  NOTICE <nick> :<response>
 *
 * IMPORTANT - Name Resolution:
 *   X3 interprets names as NICKS by default. To specify an ACCOUNT name,
 *   prefix with '*'. Example: ADDUSER #chan *accountname 200
 *   Methods in this class handle this automatically where appropriate.
 *
 * Access Level System:
 *   1-99:   Peon/Voice - Basic channel access
 *   100-199: HalfOp - Limited moderation
 *   200-299: Operator - Full channel moderation
 *   300-399: Manager - User management
 *   400-499: Co-Owner - Most settings
 *   500+:    Owner - Full control
 */

import { RawSocketClient, createRawSocketClient, PRIMARY_SERVER } from './ircv3-client.js';
import { uniqueId, retryAsync, waitForCondition } from './cap-bundles.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * X3 Admin account credentials (created by x3-admin-init on first startup).
 * First oper to register gets olevel 1000.
 */
export const X3_ADMIN = {
  account: process.env.X3_ADMIN || 'testadmin',
  password: process.env.X3_ADMIN_PASS || 'testadmin123',
};

/**
 * IRC Oper credentials (from ircd.conf).
 */
export const IRC_OPER = {
  name: process.env.OPER_NAME || 'oper',
  password: process.env.OPER_PASS || 'shmoo',
};

/**
 * Access levels for ChanServ.
 */
export const ACCESS_LEVELS = {
  PEON: 1,
  VOICE: 100,
  HALFOP: 150,
  OP: 200,
  MANAGER: 300,
  COOWNER: 400,
  OWNER: 500,
} as const;

/**
 * Service response from X3.
 */
export interface ServiceResponse {
  /** Lines received from the service */
  lines: string[];
  /** Whether the command appeared successful */
  success: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * X3-aware IRC client with service command helpers.
 */
export class X3Client extends RawSocketClient {
  private serviceTimeout = 10000;

  /**
   * Send a command to a service and collect NOTICE responses.
   *
   * Uses adaptive timing:
   * - Wait up to `timeout` for the FIRST response (handles busy servers)
   * - After first response, use short timeout (500ms) for subsequent lines
   * - This prevents stale responses from previous commands bleeding in
   *
   * @param service - Service name (AuthServ, ChanServ, X3, O3, OpServ)
   * @param command - Command to send
   * @param timeout - Max time to wait for first response (default 10s)
   * @returns Array of response lines
   */
  async serviceCmd(service: string, command: string, timeout = 10000): Promise<string[]> {
    this.clearRawBuffer();
    this.send(`PRIVMSG ${service} :${command}`);

    const lines: string[] = [];
    const startTime = Date.now();

    // Helper to check if line is from our target service
    const isServiceLine = (line: string): boolean => {
      return line.includes('x3.services') ||
             line.toLowerCase().includes(service.toLowerCase() + '!');
    };

    // Wait for FIRST response with full timeout (server may be busy)
    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(
          new RegExp(`NOTICE.*:`, 'i'),
          Math.min(2000, timeout - (Date.now() - startTime))
        );

        if (isServiceLine(line)) {
          lines.push(line);
          break; // Got first response, switch to fast collection
        }
        // Non-service NOTICE (server notice, etc.) - keep waiting
      } catch {
        // Timeout - no response yet, keep waiting until overall timeout
      }
    }

    // If no first response, return empty
    if (lines.length === 0) {
      return lines;
    }

    // Collect remaining responses with short timeout
    // Increased from 500ms to handle slow X3/Keycloak responses
    const fastTimeout = 1000;
    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(
          new RegExp(`NOTICE.*:`, 'i'),
          fastTimeout
        );

        if (isServiceLine(line)) {
          lines.push(line);
        }
      } catch {
        // Timeout with no response = service is done responding
        break;
      }
    }

    return lines;
  }

  /**
   * Wait for NOTICE from a specific service.
   */
  async waitForServiceNotice(service: string, pattern: RegExp, timeout = 10000): Promise<string> {
    const servicePattern = new RegExp(`${service}.*NOTICE.*${pattern.source}`, 'i');
    return this.waitForLine(servicePattern, timeout);
  }

  // ============================================================================
  // AuthServ Commands
  // ============================================================================

  /**
   * Register an account via AuthServ.
   * Requires being unauthenticated.
   * Note: If email is provided and email_enabled=1, this triggers email verification.
   * Use registerAndActivate() for automatic activation via cookie scraping.
   */
  async registerAccount(account: string, password: string, email: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `REGISTER ${account} ${password} ${email}`);
    const success = lines.some(l =>
      l.includes('has been registered') ||
      l.includes('successfully') ||
      l.includes('created')
    );
    const error = lines.find(l =>
      l.includes('already') ||
      l.includes('error') ||
      l.includes('denied') ||
      l.includes('invalid')
    );
    return { lines, success, error };
  }

  /**
   * Activate an account using a cookie.
   * For ACTIVATION cookies, password is required (verifies original registration password).
   */
  async activateAccount(account: string, cookie: string, password: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `COOKIE ${account} ${cookie} ${password}`);
    const success = lines.some(l =>
      l.includes('activated') ||
      l.includes('Account activated') ||
      l.includes('now authenticated') ||
      l.includes('I recognize you')
    );
    const error = lines.find(l =>
      l.includes('invalid') ||
      l.includes('incorrect') ||
      l.includes('expired')
    );
    return { lines, success, error };
  }

  /**
   * Register and activate an account by scraping the cookie from X3 logs.
   * This is the preferred method for tests when email verification is enabled.
   * Uses polling to handle race condition where logs may not be flushed immediately.
   */
  async registerAndActivate(account: string, password: string, email: string): Promise<ServiceResponse> {
    // First register
    const regResult = await this.registerAccount(account, password, email);
    if (!regResult.success) {
      return regResult;
    }

    // Poll for cookie in logs instead of fixed delay (handles race condition)
    let cookie: string | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try {
        const { stdout } = await execAsync(`docker logs x3 2>&1 | grep "Created cookie type=0 for ${account}:" | tail -1`);
        const match = stdout.match(/Created cookie type=0 for \S+: (\S+)/);
        if (match) {
          cookie = match[1].trim();
          break;
        }
      } catch {
        // Continue polling - grep returns non-zero if no match
      }
    }

    if (!cookie) {
      return { lines: regResult.lines, success: false, error: 'Could not find activation cookie in logs after 10 attempts' };
    }

    // Activate with the cookie (requires password for ACTIVATION cookies)
    const activateResult = await this.activateAccount(account, cookie, password);
    return {
      lines: [...regResult.lines, ...activateResult.lines],
      success: activateResult.success,
      error: activateResult.error,
    };
  }

  /**
   * Authenticate via AuthServ.
   */
  async auth(account: string, password: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `AUTH ${account} ${password}`);
    const success = lines.some(l =>
      l.includes('recognized') ||
      l.includes('authenticated') ||
      l.includes('logged in') ||
      l.includes('I recognize you') ||
      l.includes('already authed')  // Already authenticated from previous auth/activation
    );
    const error = lines.find(l =>
      l.includes('Incorrect password') ||  // X3's actual message
      l.includes('incorrect') ||
      l.includes('invalid') ||
      l.includes('denied') ||
      l.includes('not registered') ||
      l.includes('keycloak error') ||
      l.includes('problem')
    );
    return { lines, success, error };
  }

  /**
   * Authenticate with retry logic for race conditions with Keycloak sync.
   * Use when auth may race with account creation or backend sync.
   */
  async authWithRetry(account: string, password: string, maxRetries = 3): Promise<ServiceResponse> {
    let lastResult: ServiceResponse = { lines: [], success: false, error: 'No attempts made' };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 500 * attempt)); // Exponential backoff
      }
      lastResult = await this.auth(account, password);
      if (lastResult.success) return lastResult;

      // Don't retry on permanent failures
      if (lastResult.error?.includes('Incorrect password') ||
          lastResult.error?.includes('not registered')) {
        return lastResult;
      }
    }
    return lastResult;
  }

  /**
   * Check if we're currently authenticated.
   */
  async checkAuth(): Promise<{ authenticated: boolean; account?: string }> {
    const lines = await this.serviceCmd('AuthServ', 'ACCOUNTINFO');

    // Check for explicit "not authenticated" or similar messages
    const notAuthLine = lines.find(l =>
      l.includes('not authenticated') ||
      l.includes('not logged in') ||
      l.includes('must first authenticate')
    );
    if (notAuthLine) {
      return { authenticated: false };
    }

    // Look for explicit account indication
    for (const line of lines) {
      // Match X3's "Account Information for <account>" header
      const infoMatch = line.match(/Account Information for\s+(\S+)/i);
      if (infoMatch) {
        return { authenticated: true, account: infoMatch[1] };
      }

      // Match "Account: username" or similar
      const accountMatch = line.match(/Account:\s*(\S+)/i);
      if (accountMatch && accountMatch[1].toLowerCase() !== 'information') {
        return { authenticated: true, account: accountMatch[1] };
      }

      // Match "logged in as username"
      const loggedInMatch = line.match(/logged in as\s+(\S+)/i);
      if (loggedInMatch) {
        return { authenticated: true, account: loggedInMatch[1] };
      }
    }

    // Default to not authenticated if no clear indication
    return { authenticated: false };
  }

  /**
   * Set a user setting via USET.
   */
  async uset(setting: string, value: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `USET ${setting} ${value}`);
    const success = lines.some(l =>
      l.includes('set to') ||
      l.includes('changed') ||
      l.includes('updated')
    );
    return { lines, success };
  }

  /**
   * Add a hostmask for authentication.
   */
  async addMask(mask: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `ADDMASK ${mask}`);
    const success = lines.some(l =>
      l.includes('added') ||
      l.includes('hostmask')
    );
    return { lines, success };
  }

  // ============================================================================
  // ChanServ (X3) Commands
  // ============================================================================

  /**
   * Register a channel via ChanServ.
   * Must be op in the channel and authenticated.
   *
   * X3 channel registration success is indicated by ChanServ joining the channel,
   * not by a NOTICE response.
   */
  async registerChannel(channel: string): Promise<ServiceResponse> {
    this.clearRawBuffer();
    this.send(`PRIVMSG ChanServ :REGISTER ${channel}`);

    const lines: string[] = [];
    let success = false;
    let error: string | undefined;
    const startTime = Date.now();
    const timeout = 15000; // Increased timeout for slow Keycloak sync

    // Watch for ChanServ joining (success) or NOTICE with error
    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(
          /ChanServ.*JOIN|NOTICE.*:/i,
          Math.min(3000, timeout - (Date.now() - startTime))
        );

        // Success: ChanServ joins the channel
        if (line.includes('ChanServ') && line.includes('JOIN')) {
          success = true;
          lines.push(line);
          break;
        }

        // NOTICE response (may be success or error)
        if (line.includes('NOTICE')) {
          lines.push(line);

          // Check for success messages
          if (line.toLowerCase().includes('registered') ||
              line.toLowerCase().includes('now own') ||
              line.toLowerCase().includes('successfully')) {
            success = true;
            break;
          }

          // Check for specific error messages
          const lowerLine = line.toLowerCase();
          if (lowerLine.includes('already registered') ||
              lowerLine.includes('registered to someone') ||
              lowerLine.includes('must be opped') ||
              lowerLine.includes('must be authenticated') ||
              lowerLine.includes('not authenticated') ||
              lowerLine.includes('you must first authenticate') ||
              lowerLine.includes('access denied') ||
              lowerLine.includes('not op in')) {
            error = line;
            break;
          }
        }
      } catch {
        // Timeout on individual line
        if (lines.length > 0 || success) break;
      }
    }

    // If we got responses but no success, use last line as error hint
    if (!success && !error && lines.length > 0) {
      error = lines[lines.length - 1];
    } else if (!success && !error) {
      error = 'No response from ChanServ (timeout)';
    }

    return { lines, success, error };
  }

  /**
   * Unregister a channel.
   */
  async unregisterChannel(channel: string, confirm = ''): Promise<ServiceResponse> {
    const cmd = confirm ? `UNREGISTER ${channel} ${confirm}` : `UNREGISTER ${channel}`;
    const lines = await this.serviceCmd('ChanServ', cmd);
    const success = lines.some(l =>
      l.includes('unregistered') ||
      l.includes('no longer registered')
    );
    // Check if confirmation is needed
    const needsConfirm = lines.some(l =>
      l.includes('confirm') ||
      l.includes('UNREGISTER')
    );
    return { lines, success, error: needsConfirm ? 'confirmation_needed' : undefined };
  }

  /**
   * Add a user to channel access list.
   * Uses *account syntax to add by account name (not nick).
   */
  async addUser(channel: string, account: string, level: number): Promise<ServiceResponse> {
    // Use *account syntax to specify account name instead of nick
    const lines = await this.serviceCmd('ChanServ', `ADDUSER ${channel} *${account} ${level}`, 15000);

    // Check for error patterns first
    const errorLine = lines.find(l => {
      const lower = l.toLowerCase();
      return lower.includes('already on') ||
             lower.includes('access denied') ||
             lower.includes('insufficient access') ||
             lower.includes('not registered') ||
             lower.includes('no such') ||
             lower.includes('outranks you') ||
             lower.includes('you may not');
    });

    // Success patterns
    const success = !errorLine && lines.some(l => {
      const lower = l.toLowerCase();
      return lower.includes('added') ||
             lower.includes('now has access') ||
             lower.includes('to the user list') ||
             lower.includes('has been added');
    });

    return { lines, success, error: errorLine };
  }

  /**
   * Change a user's access level.
   * Uses *account syntax to specify by account name.
   */
  async clvl(channel: string, account: string, level: number): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('ChanServ', `CLVL ${channel} *${account} ${level}`);

    // Check for explicit error patterns first
    const hasError = lines.some(l => {
      const lower = l.toLowerCase();
      return lower.includes('denied') ||
             lower.includes('insufficient') ||
             lower.includes('no such') ||
             lower.includes('not found') ||
             lower.includes('cannot') ||
             lower.includes('invalid') ||
             lower.includes('error');
    });

    // Success: look for positive confirmation patterns
    // X3 typically says "access level for X changed to Y" or similar
    const success = !hasError && lines.some(l => {
      const lower = l.toLowerCase();
      return (lower.includes('access') && lower.includes('changed')) ||
             (lower.includes('level') && lower.includes('changed')) ||
             lower.includes('now has') ||
             lower.includes('set to');
    });

    const error = hasError ? lines.find(l => l.toLowerCase().includes('denied') || l.toLowerCase().includes('error')) : undefined;
    return { lines, success, error };
  }

  /**
   * Remove a user from channel access list.
   * Uses *account syntax to specify by account name.
   */
  async delUser(channel: string, account: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('ChanServ', `DELUSER ${channel} *${account}`);
    const success = lines.some(l =>
      l.toLowerCase().includes('removed') ||
      l.toLowerCase().includes('deleted') ||
      l.toLowerCase().includes('no longer')
    );
    return { lines, success };
  }

  /**
   * Get a specific user's access in a channel.
   * Uses USERS command for listing, ACCESS for specific lookup.
   *
   * USERS format (table):
   * :Access Account    Last Seen Status Expiry
   * :Owner  testuser   Here      Normal Never
   * :Op     testop     Never     Normal Never
   */
  async getAccess(channel: string, account?: string): Promise<Array<{ account: string; level: number }>> {
    // Use ACCESS for specific user, or USERS to list all
    const cmd = account ? `ACCESS ${channel} *${account}` : `USERS ${channel}`;
    const lines = await this.serviceCmd('ChanServ', cmd);

    // Map role names to numeric levels
    const roleToLevel: Record<string, number> = {
      'owner': 500,
      'coowner': 400,
      'manager': 300,
      'op': 200,
      'halfop': 150,
      'peon': 100,
      'voice': 100,
    };

    const accessList: Array<{ account: string; level: number }> = [];

    for (const line of lines) {
      // Skip header lines
      if (line.includes('Access Account') || line.includes('---') || line.includes('End (')) {
        continue;
      }

      // Parse USERS table format: "Role  account  LastSeen  Status  Expiry"
      // The role is first, followed by account name
      const tableMatch = line.match(/:(\w+)\s+(\S+)\s+(Here|Never|\d+)/i);
      if (tableMatch) {
        const role = tableMatch[1].toLowerCase();
        const acc = tableMatch[2];
        const level = roleToLevel[role];
        if (level !== undefined) {
          accessList.push({ account: acc, level });
        }
      }

      // Also try ACCESS command format: "nick (account) has Role access (level) in #channel"
      const accessMatch = line.match(/\((\S+)\)\s+has\s+\S+\s+access\s+\((\d+)\)/i);
      if (accessMatch) {
        accessList.push({
          account: accessMatch[1],
          level: parseInt(accessMatch[2], 10),
        });
      }
    }

    return accessList;
  }

  /**
   * Set a channel mode/setting.
   */
  async set(channel: string, setting: string, value?: string): Promise<ServiceResponse> {
    const cmd = value ? `SET ${channel} ${setting} ${value}` : `SET ${channel} ${setting}`;
    const lines = await this.serviceCmd('ChanServ', cmd);
    const success = lines.some(l =>
      l.includes('set') ||
      l.includes('changed') ||
      l.includes('enabled') ||
      l.includes('disabled')
    );
    return { lines, success };
  }

  /**
   * Ban a user from channel.
   */
  async ban(channel: string, target: string, reason?: string): Promise<ServiceResponse> {
    // X3 uses ADDLAMER command to add bans
    const cmd = reason ? `ADDLAMER ${channel} ${target} ${reason}` : `ADDLAMER ${channel} ${target}`;
    const lines = await this.serviceCmd('ChanServ', cmd);
    const success = lines.some(l =>
      l.includes('LAMER') ||
      l.includes('banned') ||
      l.includes('added')
    );
    return { lines, success };
  }

  /**
   * Remove a ban from channel.
   */
  async unban(channel: string, target: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('ChanServ', `UNBAN ${channel} ${target}`);
    const success = lines.some(l =>
      l.includes('removed') ||
      l.includes('unbanned')
    );
    return { lines, success };
  }

  // ============================================================================
  // OpServ (O3) Commands
  // ============================================================================

  /**
   * Add a G-line (network-wide ban).
   * Requires oper access.
   */
  async gline(mask: string, duration: string, reason: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('O3', `GLINE ${mask} ${duration} ${reason}`);
    const success = lines.some(l =>
      l.includes('added') ||
      l.includes('gline') ||
      l.includes('G-line')
    );
    const error = lines.find(l =>
      l.includes('denied') ||
      l.includes('access') ||
      l.includes('must be') ||
      l.includes('privileged')
    );
    return { lines, success, error };
  }

  /**
   * Remove a G-line.
   */
  async ungline(mask: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('O3', `UNGLINE ${mask}`);
    const success = lines.some(l =>
      l.includes('removed') ||
      l.includes('deleted')
    );
    return { lines, success };
  }

  /**
   * Force-join a channel (oper command).
   */
  async forceJoin(target: string, channel: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('O3', `JOIN ${target} ${channel}`);
    return { lines, success: true };
  }

  /**
   * Get OpServ access level.
   * Returns the oper level (0-1000) for the authenticated user.
   */
  async myAccess(): Promise<number> {
    const lines = await this.serviceCmd('O3', 'ACCESS');
    for (const line of lines) {
      // Match "has X access" format from O3
      const match = line.match(/has\s+(\d+)\s+access/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return 0;
  }
}

/**
 * Create an X3-aware client.
 */
export async function createX3Client(nick?: string): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);

  await client.capLs();
  client.capEnd();
  client.register(nick || `x3test${uniqueId().slice(0, 5)}`);
  await client.waitForLine(/001/);

  return client;
}

/**
 * Create an authenticated X3 client using SASL.
 * Requires Keycloak to be configured.
 */
export async function createAuthenticatedX3Client(
  username: string,
  password: string,
  nick?: string
): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);

  await client.capLs();
  const caps = await client.capReq(['sasl']);

  if (caps.ack.includes('sasl')) {
    client.send('AUTHENTICATE PLAIN');
    try {
      await client.waitForLine(/AUTHENTICATE \+/, 5000);

      // Encode credentials
      const credentials = Buffer.from(`${username}\0${username}\0${password}`).toString('base64');
      client.send(`AUTHENTICATE ${credentials}`);

      // Wait for success or failure
      const result = await client.waitForLine(/903|904|905|906/, 10000);
      if (!result.includes('903')) {
        throw new Error('SASL authentication failed');
      }
    } catch {
      // SASL failed, continue without auth
    }
  }

  client.capEnd();
  client.register(nick || username);
  await client.waitForLine(/001/);

  return client;
}

/**
 * Create a test account for X3 testing.
 * Returns the account name and password.
 */
export async function createTestAccount(): Promise<{ account: string; password: string; email: string }> {
  const id = uniqueId().slice(0, 6);
  return {
    account: `test${id}`,
    password: `pass${id}`,
    email: `test${id}@example.com`,
  };
}

/**
 * Create an oper client that's authenticated with AuthServ.
 * Uses IRC_OPER for oper access and X3_ADMIN for AuthServ.
 * This gives access to O3 (OpServ) commands.
 */
export async function createOperClient(nick?: string): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);

  await client.capLs();
  client.capEnd();
  client.register(nick || `oper${uniqueId().slice(0, 5)}`);
  await client.waitForLine(/001/);

  // Oper up
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  try {
    await client.waitForLine(/381/, 5000); // RPL_YOUREOPER
  } catch {
    console.warn('Failed to oper up - may affect O3 commands');
  }

  // Auth with X3 admin account
  client.send(`PRIVMSG AuthServ :AUTH ${X3_ADMIN.account} ${X3_ADMIN.password}`);
  try {
    await client.waitForLine(/I recognize you|authenticated/i, 5000);
  } catch {
    console.warn('Failed to auth with X3 - O3 commands may fail');
  }

  return client;
}

/**
 * Wait for a user to appear in a channel's access list.
 * Use after ADDUSER to verify the operation completed before proceeding.
 */
export async function waitForUserAccess(
  client: X3Client,
  channel: string,
  account: string,
  expectedLevel?: number,
  timeoutMs = 5000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const accessList = await client.getAccess(channel);
    const entry = accessList.find(
      e => e.account.toLowerCase() === account.toLowerCase()
    );

    if (entry) {
      if (expectedLevel === undefined || entry.level === expectedLevel) {
        return true;
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}

/**
 * Wait for a user to have a specific channel mode (op, voice, etc) after joining.
 *
 * This handles the timing issue where ChanServ may not grant modes immediately
 * after a user joins. It checks NAMES with retries to allow ChanServ time to process.
 *
 * @param client - The client to use for NAMES queries (should be in the channel)
 * @param channel - Channel name
 * @param nick - Nick to check for mode
 * @param modePrefix - Expected prefix: '@' for op, '+' for voice, '%' for halfop
 * @param timeoutMs - How long to wait (default 5s)
 * @returns true if user has expected mode, false on timeout
 */
export async function waitForChannelMode(
  client: X3Client,
  channel: string,
  nick: string,
  modePrefix: '@' | '+' | '%',
  timeoutMs = 5000
): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 300; // Check every 300ms
  const debug = process.env.DEBUG === '1';
  let lastNamesResponse = '';

  if (debug) {
    console.log(`[waitForChannelMode] Looking for ${modePrefix}${nick} in ${channel}, timeout=${timeoutMs}ms`);
  }

  while (Date.now() - startTime < timeoutMs) {
    // Send NAMES and check response
    // Don't clear buffer - we might want to see MODE messages too
    client.send(`NAMES ${channel}`);

    try {
      const namesResponse = await client.waitForLine(/353.*:/, 3000);
      lastNamesResponse = namesResponse;

      // Check if user has the expected prefix
      // Handle multiple prefixes (e.g., @+nick for op+voice)
      // Pattern: prefix(es) followed by nick and word boundary or space
      // Note: + needs to be escaped in regex since it's a quantifier
      const escapedPrefix = modePrefix === '+' ? '\\+' : modePrefix;
      const prefixPattern = new RegExp(`[@+%]*${escapedPrefix}[@+%]*${nick}(?:\\s|$)`, 'i');

      if (debug) {
        console.log(`[waitForChannelMode] NAMES response: ${namesResponse}`);
        console.log(`[waitForChannelMode] Pattern: ${prefixPattern}, matches: ${prefixPattern.test(namesResponse)}`);
      }

      if (prefixPattern.test(namesResponse)) {
        return true;
      }
    } catch {
      // NAMES timeout, will retry
      if (debug) {
        console.log(`[waitForChannelMode] NAMES timeout, retrying...`);
      }
    }

    // Wait before next check
    await new Promise(r => setTimeout(r, checkInterval));
  }

  // Timeout - log final state for debugging
  console.log(`[waitForChannelMode] TIMEOUT: Looking for ${modePrefix}${nick} in ${channel}`);
  console.log(`[waitForChannelMode] Last NAMES response: ${lastNamesResponse}`);

  return false;
}

/**
 * Wait for an account to be queryable (useful after registration + activation).
 * Polls auth until it succeeds or returns "Incorrect password" (account exists).
 */
export async function waitForAccountExists(
  client: X3Client,
  account: string,
  password: string,
  timeoutMs = 5000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await client.auth(account, password);
    if (result.success) return true;

    // If wrong password, account exists (just wrong creds)
    if (result.error?.includes('Incorrect password')) return true;

    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}
