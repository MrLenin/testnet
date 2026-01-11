import { randomUUID } from 'crypto';

/**
 * IRCv3 Capability Bundles
 *
 * Many capabilities have dependencies or work best together.
 * These bundles ensure tests request all required capabilities.
 */

/**
 * Capability bundles for common use cases.
 * Each bundle includes the primary capability and its dependencies.
 */
export const CAP_BUNDLES: Record<string, string[]> = {
  /** For testing echo-message - needs tags and server-time for full validation */
  messaging: ['message-tags', 'server-time', 'echo-message'],

  /** For testing labeled-response - needs batch for labeled responses */
  batching: ['batch', 'labeled-response', 'message-tags'],

  /** For testing chathistory - needs batch for history delivery */
  chathistory: ['draft/chathistory', 'batch', 'server-time', 'message-tags'],

  /** For testing account features - away, account, extended-join work together */
  accounts: ['away-notify', 'account-notify', 'extended-join'],

  /** For testing SASL authentication */
  sasl: ['sasl'],

  /** For testing channel metadata */
  metadata: ['draft/metadata-2', 'message-tags'],

  /** For testing multiline messages */
  multiline: ['draft/multiline', 'batch', 'message-tags'],

  /** For testing webpush notifications */
  webpush: ['draft/webpush'],

  /** For testing event playback with chathistory */
  eventPlayback: ['draft/event-playback', 'draft/chathistory', 'batch', 'server-time', 'message-tags'],

  /** Common base capabilities for most tests */
  base: ['message-tags', 'server-time', 'multi-prefix'],
};

export type CapBundle = keyof typeof CAP_BUNDLES;

/**
 * Get capabilities for a bundle, optionally adding extra caps.
 */
export function getCaps(bundle: CapBundle, ...extra: string[]): string[] {
  return [...CAP_BUNDLES[bundle], ...extra];
}

/**
 * Get multiple bundles merged together.
 */
export function getMergedCaps(...bundles: CapBundle[]): string[] {
  const caps = new Set<string>();
  for (const bundle of bundles) {
    for (const cap of CAP_BUNDLES[bundle]) {
      caps.add(cap);
    }
  }
  return Array.from(caps);
}

/**
 * Generate a unique ID for test isolation.
 * Use this instead of Date.now() to avoid collisions between parallel tests.
 */
export function uniqueId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Generate a unique channel name for test isolation.
 */
export function uniqueChannel(prefix = 'test'): string {
  return `#${prefix}-${uniqueId()}`;
}

/**
 * Generate a unique nickname for test isolation.
 */
export function uniqueNick(prefix = 'user'): string {
  return `${prefix}${uniqueId().slice(0, 5)}`;
}

/**
 * Retry an async operation with exponential backoff.
 * Useful for operations that may fail due to timing issues.
 *
 * @param fn - Async function to retry
 * @param options - Retry options
 * @returns Result of successful operation
 * @throws Last error if all retries fail
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 2000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Wait for a condition to be true with polling.
 * More resilient than fixed delays for async operations.
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Polling options
 * @returns Result of condition function when true
 * @throws Error if timeout is reached
 */
export async function waitForCondition<T>(
  condition: () => Promise<T | null | undefined | false>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    description?: string;
  } = {}
): Promise<T> {
  const {
    timeoutMs = 10000,
    pollIntervalMs = 100,
    description = 'condition',
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await condition();
    if (result) {
      return result;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Collect messages from a chathistory BATCH response with proper timeout handling.
 * Fixes nested timeout cascade issue where BATCH arriving late leaves insufficient
 * time for message collection.
 */
export async function collectChathistoryBatch(
  client: { waitForLine: (pattern: RegExp, timeout?: number) => Promise<string> },
  options: {
    batchTimeout?: number;
    messageTimeout?: number;
  } = {}
): Promise<{ batchId: string; messages: string[] }> {
  const { batchTimeout = 8000, messageTimeout = 3000 } = options;

  // Wait for batch start with full timeout
  const batchStart = await client.waitForLine(/BATCH \+(\S+) chathistory/i, batchTimeout);
  const batchMatch = batchStart.match(/BATCH \+(\S+)/);
  if (!batchMatch) {
    throw new Error('Failed to parse batch ID from: ' + batchStart);
  }
  const batchId = batchMatch[1];

  // Collect messages until batch end with separate timeout budget
  const messages: string[] = [];
  const collectionStart = Date.now();
  const maxCollectionTime = 30000; // Hard limit prevents infinite loops

  while (Date.now() - collectionStart < maxCollectionTime) {
    try {
      const line = await client.waitForLine(/PRIVMSG|NOTICE|BATCH -/i, messageTimeout);
      if (line.includes('BATCH -')) break;
      if (/PRIVMSG|NOTICE/.test(line)) messages.push(line);
    } catch {
      // Timeout = no more messages in batch
      break;
    }
  }

  return { batchId, messages };
}

/**
 * Query CHATHISTORY with polling until expected messages are found.
 * This properly handles async LMDB persistence in Nefarious rather than using fixed delays.
 *
 * @param client - IRC client with send/waitForLine methods
 * @param target - Channel or user to query history for
 * @param options - Configuration options
 * @returns Array of history messages
 * @throws Error if timeout is reached before expected messages appear
 */
export async function waitForChathistory(
  client: {
    send: (line: string) => void;
    waitForLine: (pattern: RegExp, timeout?: number) => Promise<string>;
    clearRawBuffer: () => void;
  },
  target: string,
  options: {
    /** Minimum number of messages expected (default: 1) */
    minMessages?: number;
    /** Maximum time to wait for messages to appear (default: 10000ms) */
    timeoutMs?: number;
    /** Time between CHATHISTORY queries (default: 200ms) */
    pollIntervalMs?: number;
    /** CHATHISTORY subcommand (default: LATEST) */
    subcommand?: 'LATEST' | 'BEFORE' | 'AFTER' | 'AROUND' | 'BETWEEN';
    /** Timestamp for BEFORE/AFTER/AROUND (default: * for LATEST) */
    timestamp?: string;
    /** Second timestamp for BETWEEN */
    timestamp2?: string;
    /** Message limit (default: 50) */
    limit?: number;
  } = {}
): Promise<string[]> {
  const {
    minMessages = 1,
    timeoutMs = 10000,
    pollIntervalMs = 200,
    subcommand = 'LATEST',
    timestamp = '*',
    timestamp2,
    limit = 50,
  } = options;

  const startTime = Date.now();
  let lastMessages: string[] = [];

  while (Date.now() - startTime < timeoutMs) {
    // Clear buffer to avoid stale data
    client.clearRawBuffer();

    // Build CHATHISTORY command
    let cmd: string;
    if (subcommand === 'BETWEEN' && timestamp2) {
      cmd = `CHATHISTORY BETWEEN ${target} timestamp=${timestamp} timestamp=${timestamp2} ${limit}`;
    } else if (subcommand === 'LATEST') {
      cmd = `CHATHISTORY LATEST ${target} ${timestamp} ${limit}`;
    } else {
      cmd = `CHATHISTORY ${subcommand} ${target} timestamp=${timestamp} ${limit}`;
    }

    client.send(cmd);

    try {
      // Wait for batch start
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 3000);
      if (!batchStart) continue;

      // Collect messages in batch
      const messages: string[] = [];
      const collectStart = Date.now();
      while (Date.now() - collectStart < 5000) {
        try {
          const line = await client.waitForLine(/PRIVMSG|NOTICE|BATCH -/i, 1000);
          if (line.includes('BATCH -')) break;
          if (/PRIVMSG|NOTICE/.test(line)) messages.push(line);
        } catch {
          break; // Timeout = no more messages
        }
      }

      lastMessages = messages;

      // Check if we have enough messages
      if (messages.length >= minMessages) {
        return messages;
      }

      // Not enough yet - wait and retry
      await new Promise(r => setTimeout(r, pollIntervalMs));
    } catch {
      // Query failed - wait and retry
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }

  // Timeout - return what we have (let caller decide if it's enough)
  throw new Error(
    `Timeout waiting for chathistory: expected ${minMessages} messages, got ${lastMessages.length} after ${timeoutMs}ms`
  );
}
