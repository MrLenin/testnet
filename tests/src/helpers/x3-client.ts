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
import { uniqueId } from './cap-bundles.js';
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
   * @param service - Service name (AuthServ, ChanServ, X3, O3, OpServ)
   * @param command - Command to send
   * @param timeout - Response timeout in ms
   * @returns Array of response lines
   */
  async serviceCmd(service: string, command: string, timeout = 10000): Promise<string[]> {
    this.clearRawBuffer();
    this.send(`PRIVMSG ${service} :${command}`);

    // Small delay to allow server to start responding before we collect
    await new Promise(r => setTimeout(r, 100));

    const lines: string[] = [];
    const startTime = Date.now();

    // Collect NOTICE responses from the service
    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(
          new RegExp(`NOTICE.*:`, 'i'),
          Math.min(3000, timeout - (Date.now() - startTime))
        );

        // Only collect lines from X3 services (AuthServ, ChanServ, O3, etc.)
        // X3 services have format: :ServiceName!ServiceName@x3.services NOTICE nick :message
        // Exclude server notices like: :testnet.fractalrealities.net NOTICE nick :...
        if (line.includes('x3.services') ||
            line.toLowerCase().includes(service.toLowerCase() + '!')) {
          lines.push(line);
        }
      } catch {
        // Timeout on individual line - if we have responses, we're done
        if (lines.length > 0) break;
        // Otherwise keep waiting until overall timeout
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
   */
  async activateAccount(account: string, cookie: string): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('AuthServ', `COOKIE ${account} ${cookie}`);
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
   */
  async registerAndActivate(account: string, password: string, email: string): Promise<ServiceResponse> {
    // First register
    const regResult = await this.registerAccount(account, password, email);
    if (!regResult.success) {
      return regResult;
    }

    // Wait a moment for logs to be written
    await new Promise(resolve => setTimeout(resolve, 500));

    // Scrape cookie from X3 docker logs
    try {
      const { stdout } = await execAsync(`docker logs x3 2>&1 | grep "Created cookie type=0 for ${account}:" | tail -1`);
      const match = stdout.match(/Created cookie type=0 for \S+: (\S+)/);
      if (!match) {
        return { lines: regResult.lines, success: false, error: 'Could not find activation cookie in logs' };
      }

      const cookie = match[1].trim();

      // Activate with the cookie
      const activateResult = await this.activateAccount(account, cookie);
      return {
        lines: [...regResult.lines, ...activateResult.lines],
        success: activateResult.success,
        error: activateResult.error,
      };
    } catch (e) {
      return { lines: regResult.lines, success: false, error: `Failed to scrape cookie: ${e}` };
    }
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

    // Look for explicit account indication like "Account: username" or "logged in as username"
    for (const line of lines) {
      // Match "Account: username" or similar (avoiding "Account Information" header)
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
    const timeout = 10000;

    // Watch for ChanServ joining (success) or NOTICE with error
    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(
          /ChanServ.*JOIN|NOTICE.*:/i,
          Math.min(2000, timeout - (Date.now() - startTime))
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

          // Check for error messages
          if (line.includes('already registered') ||
              line.includes('registered to someone') ||
              line.includes('must be') ||
              line.includes('authenticate') ||
              line.includes('denied') ||
              line.includes('not op')) {
            error = line;
            break;
          }
        }
      } catch {
        // Timeout on individual line
        if (lines.length > 0 || success) break;
      }
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
    const lines = await this.serviceCmd('ChanServ', `ADDUSER ${channel} *${account} ${level}`);
    const success = lines.some(l =>
      l.toLowerCase().includes('added') ||
      l.toLowerCase().includes('now has access') ||
      l.toLowerCase().includes('user list')
    );
    const error = lines.find(l =>
      l.includes('already') ||
      l.includes('denied') ||
      l.includes('not registered') ||
      l.includes('no such')
    );
    return { lines, success, error };
  }

  /**
   * Change a user's access level.
   * Uses *account syntax to specify by account name.
   */
  async clvl(channel: string, account: string, level: number): Promise<ServiceResponse> {
    const lines = await this.serviceCmd('ChanServ', `CLVL ${channel} *${account} ${level}`);
    const success = lines.some(l =>
      l.includes('access') ||
      l.includes('level') ||
      l.includes('changed')
    );
    return { lines, success };
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
