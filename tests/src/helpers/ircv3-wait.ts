/**
 * IRCv3-Specific Wait Helpers
 *
 * Provides specialized wait functions for IRCv3 extensions like
 * read-marker, labeled-response, metadata, and batch handling.
 */

import type { RawSocketClient, IRCMessage, ActiveBatch } from './ircv3-client.js';

/**
 * Default timeouts for IRCv3 operations
 */
const DEFAULT_TIMEOUTS = {
  markread: 5000,
  labeledResponse: 10000,
  batch: 10000,
  metadata: 5000,
};

/**
 * Wait for a MARKREAD response.
 *
 * The MARKREAD command is used with the draft/read-marker capability
 * to sync read positions across clients.
 *
 * @param client - IRC client with draft/read-marker capability
 * @param channel - Optional channel to filter for (if omitted, accepts any MARKREAD)
 * @param timeout - Optional timeout in ms (default 5000)
 * @returns The MARKREAD message
 *
 * @example
 * ```typescript
 * client.send('MARKREAD #channel timestamp=2024-01-01T00:00:00.000Z');
 * const response = await waitForMarkread(client, '#channel');
 * expect(response.params[1]).toMatch(/timestamp=/);
 * ```
 */
export async function waitForMarkread(
  client: RawSocketClient,
  channel?: string,
  timeout: number = DEFAULT_TIMEOUTS.markread
): Promise<IRCMessage> {
  return client.waitForParsedLine(
    msg => {
      if (msg.command !== 'MARKREAD') return false;
      if (channel && msg.params[0]?.toLowerCase() !== channel.toLowerCase()) return false;
      return true;
    },
    timeout
  );
}

/**
 * Result of waiting for a labeled response
 */
export interface LabeledResponseResult {
  /** All messages in the labeled batch */
  messages: IRCMessage[];
  /** The ACK message if received (for single-response commands) */
  ack?: IRCMessage;
  /** The batch reference if a batch was used */
  batchRef?: string;
}

/**
 * Wait for a labeled response to a command.
 *
 * The labeled-response capability allows correlating server responses
 * with specific client commands using labels.
 *
 * Handles both:
 * - Single-response commands (ACK with matching label)
 * - Multi-response commands (BATCH with matching label)
 *
 * @param client - IRC client with labeled-response capability
 * @param label - The label sent with the command
 * @param timeout - Optional timeout in ms (default 10000)
 * @returns The labeled response (messages and/or ACK)
 *
 * @example
 * ```typescript
 * // Single response
 * client.rawWithTags({ label: 'abc123' }, 'PING :test');
 * const result = await waitForLabeledResponse(client, 'abc123');
 * expect(result.ack).toBeDefined();
 *
 * // Batch response
 * client.rawWithTags({ label: 'xyz789' }, 'WHO #channel');
 * const result = await waitForLabeledResponse(client, 'xyz789');
 * expect(result.messages.length).toBeGreaterThan(0);
 * ```
 */
export async function waitForLabeledResponse(
  client: RawSocketClient,
  label: string,
  timeout: number = DEFAULT_TIMEOUTS.labeledResponse
): Promise<LabeledResponseResult> {
  const startTime = Date.now();
  const messages: IRCMessage[] = [];
  let ack: IRCMessage | undefined;
  let batchRef: string | undefined;
  let inBatch = false;

  while (Date.now() - startTime < timeout) {
    const remainingTime = timeout - (Date.now() - startTime);
    if (remainingTime <= 0) break;

    try {
      const msg = await client.waitForParsedLine(
        m => {
          // Check for label tag
          if (m.tags['label'] === label) return true;
          // Check for batch messages if we're in a labeled batch
          if (batchRef && m.tags['batch'] === batchRef) return true;
          // Check for BATCH start/end with our batch ref
          if (m.command === 'BATCH' && batchRef) {
            const ref = m.params[0]?.replace(/^[+-]/, '');
            if (ref === batchRef) return true;
          }
          return false;
        },
        Math.min(remainingTime, 2000)
      );

      // Handle different message types
      if (msg.command === 'ACK') {
        ack = msg;
        // ACK without batch means we're done
        if (!inBatch) {
          return { messages, ack, batchRef };
        }
      } else if (msg.command === 'BATCH') {
        const refWithPrefix = msg.params[0];
        if (refWithPrefix?.startsWith('+')) {
          // Batch start
          batchRef = refWithPrefix.slice(1);
          inBatch = true;
        } else if (refWithPrefix?.startsWith('-')) {
          // Batch end
          inBatch = false;
          return { messages, ack, batchRef };
        }
      } else if (msg.tags['label'] === label || (batchRef && msg.tags['batch'] === batchRef)) {
        messages.push(msg);
      }
    } catch {
      // Timeout on individual wait - check if we have partial results
      if (messages.length > 0 || ack) {
        return { messages, ack, batchRef };
      }
      // Continue waiting unless overall timeout exceeded
    }
  }

  // Return whatever we collected (may be empty)
  return { messages, ack, batchRef };
}

/**
 * Result of waiting for a batch
 */
export interface BatchResult {
  /** Batch start message */
  start: IRCMessage;
  /** Messages within the batch */
  messages: IRCMessage[];
  /** Batch end message */
  end: IRCMessage;
  /** Batch type (e.g., 'chathistory', 'labeled-response') */
  type: string;
  /** Batch reference ID */
  ref: string;
}

/**
 * Wait for a complete BATCH from start to end.
 *
 * @param client - IRC client with batch capability
 * @param type - Optional batch type to filter for
 * @param batchRef - Optional specific batch reference to wait for
 * @param timeout - Optional timeout in ms (default 10000)
 * @returns The complete batch with start, messages, and end
 *
 * @example
 * ```typescript
 * client.send('CHATHISTORY LATEST #channel * 10');
 * const batch = await waitForBatchComplete(client, 'chathistory');
 * expect(batch.messages.length).toBeLessThanOrEqual(10);
 * ```
 */
export async function waitForBatchComplete(
  client: RawSocketClient,
  type?: string,
  batchRef?: string,
  timeout: number = DEFAULT_TIMEOUTS.batch
): Promise<BatchResult> {
  const startTime = Date.now();

  // Wait for batch start
  let start: IRCMessage;
  try {
    start = await client.waitForParsedLine(
      msg => {
        if (msg.command !== 'BATCH') return false;
        if (!msg.params[0]?.startsWith('+')) return false;
        if (type && msg.params[1] !== type) return false;
        if (batchRef && msg.params[0].slice(1) !== batchRef) return false;
        return true;
      },
      timeout
    );
  } catch (err) {
    throw new Error(`Timeout waiting for BATCH start${type ? ` (type: ${type})` : ''}`);
  }

  const ref = start.params[0].slice(1); // Remove '+' prefix
  const batchType = start.params[1] || 'unknown';
  const messages: IRCMessage[] = [];

  // Collect messages until batch end
  while (Date.now() - startTime < timeout) {
    const remainingTime = timeout - (Date.now() - startTime);
    if (remainingTime <= 0) break;

    try {
      const msg = await client.waitForParsedLine(
        m => m.tags['batch'] === ref || (m.command === 'BATCH' && m.params[0] === `-${ref}`),
        Math.min(remainingTime, 2000)
      );

      if (msg.command === 'BATCH' && msg.params[0] === `-${ref}`) {
        // Batch end
        return {
          start,
          messages,
          end: msg,
          type: batchType,
          ref,
        };
      }

      // Add message to batch
      messages.push(msg);
    } catch {
      // Individual timeout - continue until overall timeout
    }
  }

  throw new Error(`Timeout waiting for BATCH end (ref: ${ref})`);
}

/**
 * Result of a metadata query
 */
export interface MetadataResult {
  /** The target (nick, channel, or * for self) */
  target: string;
  /** Key-value pairs retrieved */
  metadata: Record<string, string>;
  /** Whether all keys were found (vs some returned errors) */
  complete: boolean;
}

/**
 * Wait for metadata response(s).
 *
 * The draft/metadata-2 capability allows querying and setting
 * user/channel metadata.
 *
 * @param client - IRC client with draft/metadata-2 capability
 * @param target - Target to get metadata for (nick, channel, or undefined for self)
 * @param keys - Optional specific keys to wait for
 * @param timeout - Optional timeout in ms (default 5000)
 * @returns Metadata result with key-value pairs
 *
 * @example
 * ```typescript
 * client.send('METADATA * GET avatar url');
 * const result = await waitForMetadata(client, '*', ['avatar', 'url']);
 * expect(result.metadata['avatar']).toBeDefined();
 * ```
 */
export async function waitForMetadata(
  client: RawSocketClient,
  target?: string,
  keys?: string[],
  timeout: number = DEFAULT_TIMEOUTS.metadata
): Promise<MetadataResult> {
  const startTime = Date.now();
  const metadata: Record<string, string> = {};
  const resolvedTarget = target || '*';
  const keysRemaining = keys ? new Set(keys) : null;
  let complete = true;

  while (Date.now() - startTime < timeout) {
    const remainingTime = timeout - (Date.now() - startTime);
    if (remainingTime <= 0) break;

    try {
      const msg = await client.waitForParsedLine(
        m => {
          // Look for metadata numerics: 761 (value), 766 (end of metadata)
          if (!['761', '762', '765', '766'].includes(m.command)) return false;
          // Check target if specified
          if (target && m.params[1]?.toLowerCase() !== target.toLowerCase()) return false;
          return true;
        },
        Math.min(remainingTime, 1000)
      );

      if (msg.command === '761') {
        // RPL_KEYVALUE: <target> <key> <visibility> :<value>
        const key = msg.params[2];
        const value = msg.params[4] || msg.trailing || '';
        metadata[key] = value;

        if (keysRemaining) {
          keysRemaining.delete(key);
          if (keysRemaining.size === 0) {
            // Got all requested keys
            return { target: resolvedTarget, metadata, complete };
          }
        }
      } else if (msg.command === '762') {
        // RPL_METADATAEND - no more metadata
        return { target: resolvedTarget, metadata, complete };
      } else if (msg.command === '765' || msg.command === '766') {
        // ERR_KEYNOTSET or ERR_NOMATCHINGKEY
        complete = false;
        if (keysRemaining) {
          // Remove from remaining but note incompleteness
          const key = msg.params[2];
          keysRemaining.delete(key);
          if (keysRemaining.size === 0) {
            return { target: resolvedTarget, metadata, complete };
          }
        }
      }
    } catch {
      // Individual timeout - check if we have results
      if (Object.keys(metadata).length > 0) {
        return { target: resolvedTarget, metadata, complete };
      }
      // Continue waiting
    }
  }

  // Return what we have
  return { target: resolvedTarget, metadata, complete };
}

/**
 * Wait for a specific capability to be acknowledged.
 *
 * @param client - IRC client
 * @param capability - Capability to wait for (e.g., 'sasl', 'draft/chathistory')
 * @param timeout - Optional timeout in ms (default 5000)
 * @returns true if capability was ACKed, false if NAKed
 *
 * @example
 * ```typescript
 * client.send('CAP REQ :draft/chathistory');
 * const enabled = await waitForCapAck(client, 'draft/chathistory');
 * expect(enabled).toBe(true);
 * ```
 */
export async function waitForCapAck(
  client: RawSocketClient,
  capability: string,
  timeout: number = 5000
): Promise<boolean> {
  const msg = await client.waitForCap(['ACK', 'NAK'], [capability], timeout);

  const subcommand = msg.params[1]?.toUpperCase();
  return subcommand === 'ACK';
}

/**
 * Wait for a TAGMSG (message with only tags, no content).
 *
 * @param client - IRC client with message-tags capability
 * @param target - Target channel or nick to filter for
 * @param tagName - Optional specific tag to require
 * @param timeout - Optional timeout in ms (default 5000)
 * @returns The TAGMSG message
 */
export async function waitForTagmsg(
  client: RawSocketClient,
  target?: string,
  tagName?: string,
  timeout: number = 5000
): Promise<IRCMessage> {
  return client.waitForParsedLine(
    msg => {
      if (msg.command !== 'TAGMSG') return false;
      if (target && msg.params[0]?.toLowerCase() !== target.toLowerCase()) return false;
      if (tagName && !(tagName in msg.tags)) return false;
      return true;
    },
    timeout
  );
}

/**
 * Wait for a standard reply (FAIL, WARN, NOTE).
 *
 * @param client - IRC client with standard-replies capability
 * @param type - Reply type to wait for
 * @param command - Optional command context to filter for
 * @param code - Optional error/warning code to filter for
 * @param timeout - Optional timeout in ms (default 5000)
 * @returns The standard reply message
 *
 * @example
 * ```typescript
 * client.send('INVALID_COMMAND');
 * const fail = await waitForStandardReply(client, 'FAIL', 'INVALID_COMMAND', 'UNKNOWN_COMMAND');
 * ```
 */
export async function waitForStandardReply(
  client: RawSocketClient,
  type: 'FAIL' | 'WARN' | 'NOTE',
  command?: string,
  code?: string,
  timeout: number = 5000
): Promise<IRCMessage> {
  return client.waitForParsedLine(
    msg => {
      if (msg.command !== type) return false;
      if (command && msg.params[0] !== command) return false;
      if (code && msg.params[1] !== code) return false;
      return true;
    },
    timeout
  );
}
