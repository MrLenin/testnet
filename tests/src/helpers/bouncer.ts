/**
 * Bouncer Test Helpers
 *
 * Provides utilities for testing the built-in bouncer feature.
 *
 * Test pattern:
 * 1. Connect with SASL (authenticated, no auto-session since DEFAULT_HOLD=FALSE)
 * 2. BOUNCER SET HOLD on → sets preference AND auto-creates session
 * 3. Test bouncer behavior (disconnect/resume, presence aggregation, etc.)
 * 4. Cleanup: BOUNCER SET HOLD off → disables hold for pool account reuse
 *
 * Config assumptions:
 * - BOUNCER_ENABLE = TRUE
 * - BOUNCER_DEFAULT_HOLD = FALSE (no auto-creation for all SASL users)
 * - BOUNCER_AUTO_RESUME = TRUE (reconnecting with SASL resumes held sessions)
 */

import { RawSocketClient, createRawSocketClient, PRIMARY_SERVER, type IRCMessage } from './ircv3-client.js';
import { authenticateSaslPlain, type SaslResult } from './sasl.js';
import { uniqueNick } from './cap-bundles.js';

/**
 * Parsed bouncer session info from BOUNCER INFO output.
 */
export interface BouncerInfo {
  /** Session state: "active", "holding", or "none" */
  state: string;
  /** Hold preference: "on" or "off" */
  hold: string;
  /** Hold preference source: "account" or "default" */
  holdSource: string;
  /** Number of times resumed */
  resumes?: number;
  /** Hold time (seconds or minutes depending on state) */
  holdTime?: number;
  /** Session ID */
  sessionId?: string;
  /** Raw response line */
  raw: string;
}

/**
 * Result from creating a SASL-authenticated bouncer client.
 */
export interface BouncerClientResult {
  /** The connected, authenticated client */
  client: RawSocketClient;
  /** Account name */
  account: string;
  /** Account password */
  password: string;
  /** Nick used for registration */
  nick: string;
}

/**
 * Create a SASL-authenticated IRC client.
 *
 * Does NOT enable hold or create a session — caller must use
 * bouncerEnableHold() to opt in to bouncer behavior.
 *
 * @param account - Account name for SASL PLAIN
 * @param password - Account password
 * @param options - Additional options
 * @returns Connected, authenticated client
 */
export async function createSaslBouncerClient(
  account: string,
  password: string,
  options: {
    nick?: string;
    extraCaps?: string[];
    host?: string;
    port?: number;
  } = {}
): Promise<BouncerClientResult> {
  const {
    nick = uniqueNick('bnc'),
    extraCaps = [],
    host = PRIMARY_SERVER.host,
    port = PRIMARY_SERVER.port,
  } = options;

  const client = await createRawSocketClient(host, port);

  await client.capLs();
  await client.capReq(['sasl', 'away-notify', ...extraCaps]);

  const saslResult = await authenticateSaslPlain(client, account, password);
  if (!saslResult.success) {
    client.close();
    throw new Error(`SASL auth failed for ${account}: ${saslResult.error}`);
  }

  client.capEnd();
  client.register(nick);
  await client.waitForNumeric('001');

  // Brief settle for registration propagation
  await new Promise(r => setTimeout(r, 300));

  return { client, account, password, nick };
}

/**
 * Enable bouncer hold for the current account.
 *
 * Sends BOUNCER SET HOLD on, which:
 * - Sets bouncer/hold metadata to "1"
 * - Auto-creates a session if none exists
 *
 * @param client - Authenticated client
 * @param timeout - Timeout for response
 * @returns true if hold was enabled (and session created if needed)
 */
export async function bouncerEnableHold(
  client: RawSocketClient,
  timeout = 5000,
): Promise<boolean> {
  client.clearRawBuffer();
  client.send('BOUNCER SET HOLD on');

  try {
    const msg = await client.waitForParsedLine(
      m => m.command === 'NOTE' || m.command === 'FAIL' ||
           (m.raw.includes('BOUNCER') && (m.raw.includes('SETTINGS_UPDATED') || m.raw.includes('SESSION_CREATED'))),
      timeout,
    );
    return !msg.raw.includes('FAIL');
  } catch {
    return false;
  }
}

/**
 * Disable bouncer hold for the current account.
 *
 * Sends BOUNCER SET HOLD off. Use this in test cleanup to ensure
 * pool accounts don't retain bouncer hold state.
 *
 * @param client - Authenticated client
 * @param timeout - Timeout for response
 * @returns true if hold was disabled
 */
export async function bouncerDisableHold(
  client: RawSocketClient,
  timeout = 5000,
): Promise<boolean> {
  client.clearRawBuffer();
  client.send('BOUNCER SET HOLD off');

  try {
    const msg = await client.waitForParsedLine(
      m => m.command === 'NOTE' || m.command === 'FAIL' ||
           (m.raw.includes('BOUNCER') && m.raw.includes('SETTINGS_UPDATED')),
      timeout,
    );
    return !msg.raw.includes('FAIL');
  } catch {
    return false;
  }
}

/**
 * Query BOUNCER INFO and parse the response.
 *
 * Response format:
 *   :server RPL_BOUNCERSETTINGS nick :state=active hold=on(account) resumes=3 hold_time=14400s session=AB-00001
 *   :server RPL_BOUNCERSETTINGS nick :state=none hold=off(default)
 *
 * @param client - Authenticated client
 * @param timeout - Timeout for response
 * @returns Parsed bouncer info, or null if command failed
 */
export async function bouncerInfo(
  client: RawSocketClient,
  timeout = 5000,
): Promise<BouncerInfo | null> {
  client.clearRawBuffer();
  client.send('BOUNCER INFO');

  try {
    const msg = await client.waitForParsedLine(
      m => {
        // Match the RPL_BOUNCERSETTINGS numeric or a FAIL
        if (m.command === 'FAIL') return true;
        // Look for the response containing state= key-value pairs
        if (m.trailing && m.trailing.includes('state=')) return true;
        return false;
      },
      timeout,
    );

    if (msg.command === 'FAIL') return null;

    return parseBouncerInfo(msg);
  } catch {
    return null;
  }
}

/**
 * Parse a BOUNCER INFO response line into structured data.
 */
function parseBouncerInfo(msg: IRCMessage): BouncerInfo {
  const raw = msg.raw;
  const text = msg.trailing || '';

  // Parse key=value pairs from the response
  const stateMatch = text.match(/state=(\w+)/);
  const holdMatch = text.match(/hold=(\w+)\((\w+)\)/);
  const resumesMatch = text.match(/resumes=(\d+)/);
  const holdTimeMatch = text.match(/hold_time=(\d+)[sm]?/);
  const sessionMatch = text.match(/session=([A-Za-z0-9]+-\d+)/);

  return {
    state: stateMatch ? stateMatch[1] : 'unknown',
    hold: holdMatch ? holdMatch[1] : 'unknown',
    holdSource: holdMatch ? holdMatch[2] : 'unknown',
    resumes: resumesMatch ? parseInt(resumesMatch[1], 10) : undefined,
    holdTime: holdTimeMatch ? parseInt(holdTimeMatch[1], 10) : undefined,
    sessionId: sessionMatch ? sessionMatch[1] : undefined,
    raw,
  };
}

/**
 * Disconnect a client abruptly (simulating a network drop).
 * This triggers the bouncer HOLDING state if the client has a session
 * with hold enabled.
 *
 * @param client - Client to disconnect
 */
export function disconnectAbruptly(client: RawSocketClient): void {
  client.close();
}

/**
 * Reconnect to a bouncer session via SASL auto-resume.
 *
 * With BOUNCER_AUTO_RESUME=TRUE, reconnecting with SASL to the same
 * account automatically resumes the held session, adopting the ghost's
 * nick and channel memberships.
 *
 * @param account - Account name
 * @param password - Account password
 * @param options - Additional options
 * @returns New client connected and resumed
 */
export async function reconnectBouncer(
  account: string,
  password: string,
  options: {
    nick?: string;
    extraCaps?: string[];
    host?: string;
    port?: number;
  } = {}
): Promise<BouncerClientResult> {
  return createSaslBouncerClient(account, password, options);
}

/**
 * Full bouncer setup: SASL connect + enable hold.
 *
 * Convenience function that creates a SASL-authenticated client
 * and enables bouncer hold (creating a session).
 *
 * @param account - Account name
 * @param password - Account password
 * @param options - Additional options
 * @returns Connected client with active bouncer session
 */
export async function createBouncerClient(
  account: string,
  password: string,
  options: {
    nick?: string;
    extraCaps?: string[];
    host?: string;
    port?: number;
  } = {}
): Promise<BouncerClientResult> {
  const result = await createSaslBouncerClient(account, password, options);
  await bouncerEnableHold(result.client);
  return result;
}

/**
 * Assert that BOUNCER INFO shows an active session.
 *
 * @param client - Client to check
 * @param description - Context for error messages
 * @returns The parsed bouncer info
 */
export async function assertBouncerActive(
  client: RawSocketClient,
  description = 'client',
): Promise<BouncerInfo> {
  const info = await bouncerInfo(client);
  if (!info) {
    throw new Error(`Expected ${description} to have bouncer info, but BOUNCER INFO failed`);
  }
  if (info.state !== 'active') {
    throw new Error(
      `Expected ${description} session to be active, got state=${info.state} (raw: ${info.raw})`
    );
  }
  return info;
}

/**
 * Assert that BOUNCER INFO shows no session.
 *
 * @param client - Client to check
 * @param description - Context for error messages
 */
export async function assertNoBouncerSession(
  client: RawSocketClient,
  description = 'client',
): Promise<void> {
  const info = await bouncerInfo(client);
  if (info && info.state !== 'none') {
    throw new Error(
      `Expected ${description} to have no bouncer session, got state=${info.state} (raw: ${info.raw})`
    );
  }
}
