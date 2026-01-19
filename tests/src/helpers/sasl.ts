/**
 * SASL Authentication Helpers
 *
 * Provides standardized SASL authentication for IRC tests.
 * Supports PLAIN and OAUTHBEARER mechanisms with proper chunking.
 *
 * SASL PLAIN Format: base64(authzid \0 authcid \0 password)
 * SASL OAUTHBEARER Format: base64(n,,\x01auth=Bearer <token>\x01\x01)
 */

import type { RawSocketClient } from './ircv3-client.js';

/** SASL chunk size per IRC specification */
const SASL_CHUNK_SIZE = 400;

/** Default timeouts for SASL operations */
const DEFAULT_TIMEOUTS = {
  /** Time to wait for AUTHENTICATE + response */
  authenticateReady: 5000,
  /** Time to wait for final 900/903/904/etc result */
  authResult: 15000,
  /** Delay between chunks to avoid flooding */
  chunkDelay: 50,
};

/**
 * SASL authentication result
 */
export interface SaslResult {
  /** Whether authentication succeeded */
  success: boolean;
  /** The numeric received (900, 903, 904, etc.) */
  numeric?: string;
  /** The account name if authenticated */
  account?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Send a SASL payload with proper 400-byte chunking.
 *
 * Per SASL specification, payloads > 400 bytes must be split into chunks.
 * If the last chunk is exactly 400 bytes, a final '+' must be sent.
 *
 * @param client - IRC client to send through
 * @param base64Payload - Base64-encoded SASL payload
 */
export async function sendSaslPayload(
  client: RawSocketClient,
  base64Payload: string
): Promise<void> {
  if (base64Payload.length <= SASL_CHUNK_SIZE) {
    client.send(`AUTHENTICATE ${base64Payload}`);
    return;
  }

  // Split into 400-byte chunks
  for (let i = 0; i < base64Payload.length; i += SASL_CHUNK_SIZE) {
    const chunk = base64Payload.slice(i, i + SASL_CHUNK_SIZE);
    client.send(`AUTHENTICATE ${chunk}`);

    // Small delay between chunks to avoid flooding
    if (i + SASL_CHUNK_SIZE < base64Payload.length) {
      await new Promise(r => setTimeout(r, DEFAULT_TIMEOUTS.chunkDelay));
    }
  }

  // If last chunk was exactly 400 bytes, send '+' to signal completion
  if (base64Payload.length % SASL_CHUNK_SIZE === 0) {
    client.send('AUTHENTICATE +');
  }
}

/**
 * Authenticate using SASL PLAIN mechanism.
 *
 * SASL PLAIN uses the format: base64(authzid \0 authcid \0 password)
 * For most IRC implementations, authzid === authcid === username.
 *
 * Prerequisites:
 * - Client must have already requested 'sasl' capability
 * - CAP negotiation should NOT be ended yet
 *
 * @param client - IRC client with sasl capability enabled
 * @param account - Account name (used for both authzid and authcid)
 * @param password - Account password
 * @param timeout - Optional timeout for auth result (default 15s)
 * @returns SASL result with success status and account info
 *
 * @example
 * ```typescript
 * const client = await createRawSocketClient();
 * await client.capLs();
 * await client.capReq(['sasl']);
 *
 * const result = await authenticateSaslPlain(client, 'myaccount', 'mypassword');
 * if (result.success) {
 *   console.log(`Authenticated as ${result.account}`);
 * }
 *
 * client.capEnd();
 * client.register('mynick');
 * ```
 */
export async function authenticateSaslPlain(
  client: RawSocketClient,
  account: string,
  password: string,
  timeout: number = DEFAULT_TIMEOUTS.authResult
): Promise<SaslResult> {
  // Initiate PLAIN authentication
  client.send('AUTHENTICATE PLAIN');

  try {
    // Wait for server to send AUTHENTICATE + (ready for credentials)
    await client.waitForParsedLine(
      msg => msg.command === 'AUTHENTICATE' && msg.params[0] === '+',
      DEFAULT_TIMEOUTS.authenticateReady
    );
  } catch {
    return {
      success: false,
      error: 'Server did not respond to AUTHENTICATE PLAIN',
    };
  }

  // Encode credentials: authzid \0 authcid \0 password
  const payload = Buffer.from(`${account}\0${account}\0${password}`).toString('base64');

  // Send payload (with chunking if needed)
  await sendSaslPayload(client, payload);

  // Wait for authentication result
  try {
    const response = await client.waitForParsedLine(
      msg => ['900', '901', '902', '903', '904', '905', '906', '907', '908'].includes(msg.command),
      timeout
    );

    const numeric = response.command;

    if (numeric === '900' || numeric === '903') {
      // 900 = RPL_LOGGEDIN (includes account name)
      // 903 = RPL_SASLSUCCESS
      const accountName = numeric === '900' ? response.params[2] : account;
      return {
        success: true,
        numeric,
        account: accountName,
      };
    }

    // Authentication failed
    const errorMessages: Record<string, string> = {
      '901': 'You must be connected with TLS to use SASL',
      '902': 'SASL authentication failed (unknown account)',
      '904': 'SASL authentication failed (bad credentials)',
      '905': 'SASL message too long',
      '906': 'SASL authentication aborted',
      '907': 'SASL authentication already in progress',
      '908': 'SASL mechanism not available',
    };

    return {
      success: false,
      numeric,
      error: errorMessages[numeric] || `SASL failed with numeric ${numeric}`,
    };
  } catch {
    return {
      success: false,
      error: 'Timeout waiting for SASL authentication result',
    };
  }
}

/**
 * Authenticate using SASL OAUTHBEARER mechanism.
 *
 * OAUTHBEARER uses the format: base64(n,,\x01auth=Bearer <token>\x01\x01)
 * Token must be a valid OAuth2 access token from the configured provider.
 *
 * Prerequisites:
 * - Client must have already requested 'sasl' capability
 * - CAP negotiation should NOT be ended yet
 * - OAUTHBEARER must be in the server's SASL mechanism list
 *
 * @param client - IRC client with sasl capability enabled
 * @param token - OAuth2 bearer token
 * @param timeout - Optional timeout for auth result (default 15s)
 * @returns SASL result with success status and account info
 *
 * @example
 * ```typescript
 * const token = await getKeycloakToken('user', 'password');
 * const result = await authenticateSaslOAuthBearer(client, token);
 * ```
 */
export async function authenticateSaslOAuthBearer(
  client: RawSocketClient,
  token: string,
  timeout: number = DEFAULT_TIMEOUTS.authResult
): Promise<SaslResult> {
  // Initiate OAUTHBEARER authentication
  client.send('AUTHENTICATE OAUTHBEARER');

  try {
    // Wait for server to send AUTHENTICATE + (ready for credentials)
    await client.waitForParsedLine(
      msg => msg.command === 'AUTHENTICATE' && msg.params[0] === '+',
      DEFAULT_TIMEOUTS.authenticateReady
    );
  } catch {
    return {
      success: false,
      error: 'Server did not respond to AUTHENTICATE OAUTHBEARER',
    };
  }

  // Encode OAUTHBEARER payload: n,,\x01auth=Bearer <token>\x01\x01
  const oauthPayload = `n,,\x01auth=Bearer ${token}\x01\x01`;
  const payload = Buffer.from(oauthPayload).toString('base64');

  // Send payload (with chunking - tokens are often > 400 bytes)
  await sendSaslPayload(client, payload);

  // Wait for authentication result
  try {
    const response = await client.waitForParsedLine(
      msg => ['900', '901', '902', '903', '904', '905', '906', '907', '908'].includes(msg.command),
      timeout
    );

    const numeric = response.command;

    if (numeric === '900' || numeric === '903') {
      // Extract account from 900 if available
      const accountName = numeric === '900' ? response.params[2] : undefined;
      return {
        success: true,
        numeric,
        account: accountName,
      };
    }

    // Check for OAUTHBEARER-specific challenge (need to send empty response)
    if (response.command === 'AUTHENTICATE' && response.params[0] !== '+') {
      // Server sent a challenge - for errors, send AUTHENTICATE + to get the error
      client.send('AUTHENTICATE +');

      // Now wait for the actual error numeric
      const errorResponse = await client.waitForParsedLine(
        msg => ['902', '904', '905', '906'].includes(msg.command),
        5000
      );

      return {
        success: false,
        numeric: errorResponse.command,
        error: `OAUTHBEARER authentication failed: ${errorResponse.params.join(' ')}`,
      };
    }

    const errorMessages: Record<string, string> = {
      '901': 'You must be connected with TLS to use SASL',
      '902': 'SASL authentication failed (unknown account)',
      '904': 'SASL authentication failed (invalid token)',
      '905': 'SASL message too long',
      '906': 'SASL authentication aborted',
      '907': 'SASL authentication already in progress',
      '908': 'SASL mechanism not available',
    };

    return {
      success: false,
      numeric,
      error: errorMessages[numeric] || `SASL failed with numeric ${numeric}`,
    };
  } catch {
    return {
      success: false,
      error: 'Timeout waiting for SASL authentication result',
    };
  }
}

/**
 * Abort an in-progress SASL authentication.
 *
 * Send AUTHENTICATE * to cancel authentication.
 * Useful for testing error handling or when switching mechanisms.
 *
 * @param client - IRC client with SASL in progress
 */
export async function abortSaslAuth(client: RawSocketClient): Promise<void> {
  client.send('AUTHENTICATE *');

  // Wait for 906 (aborted) confirmation
  try {
    await client.waitForParsedLine(msg => msg.command === '906', 3000);
  } catch {
    // Server may not send 906 in all cases
  }
}

/**
 * Complete SASL authentication flow including CAP negotiation.
 *
 * This is a convenience function that handles the full SASL flow:
 * 1. Request sasl capability
 * 2. Perform authentication
 * 3. End CAP negotiation
 *
 * Prerequisites:
 * - Client must have already called capLs()
 * - CAP negotiation should NOT be ended yet
 *
 * @param client - IRC client after capLs()
 * @param mechanism - SASL mechanism to use
 * @param credentials - Authentication credentials
 * @param timeout - Optional timeout for auth result
 * @returns SASL result
 *
 * @example
 * ```typescript
 * const client = await createRawSocketClient();
 * await client.capLs();
 *
 * const result = await performSaslAuth(client, 'PLAIN', {
 *   account: 'myaccount',
 *   password: 'mypassword'
 * });
 *
 * // Note: Does NOT call capEnd() - caller should do that
 * ```
 */
export async function performSaslAuth(
  client: RawSocketClient,
  mechanism: 'PLAIN' | 'OAUTHBEARER',
  credentials: { account: string; password: string } | { token: string },
  timeout?: number
): Promise<SaslResult> {
  // Request sasl capability
  const caps = await client.capReq(['sasl']);

  if (!caps.ack.includes('sasl')) {
    return {
      success: false,
      error: 'Server does not support SASL capability',
    };
  }

  // Perform authentication based on mechanism
  if (mechanism === 'PLAIN') {
    if (!('account' in credentials)) {
      return {
        success: false,
        error: 'PLAIN mechanism requires account and password',
      };
    }
    return authenticateSaslPlain(client, credentials.account, credentials.password, timeout);
  } else {
    if (!('token' in credentials)) {
      return {
        success: false,
        error: 'OAUTHBEARER mechanism requires token',
      };
    }
    return authenticateSaslOAuthBearer(client, credentials.token, timeout);
  }
}
