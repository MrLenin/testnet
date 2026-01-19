/**
 * Test Assertion Helpers
 *
 * Provides standardized assertion patterns for IRC test suites.
 * Replaces weak assertions (toBeDefined, length > 0) with specific checks.
 */

import { expect } from 'vitest';
import type { IRCMessage } from './ircv3-client.js';
import type { ServiceResponse } from './x3-client.js';

/**
 * Assert that a service response indicates success.
 *
 * Replaces the weak pattern:
 *   expect(result.lines.length).toBeGreaterThan(0);
 *   expect(result.success).toBe(true);
 *
 * With a stronger assertion that also validates response content.
 *
 * @param result - Service response to validate
 * @param expectedPattern - Optional regex to match against response lines
 * @throws AssertionError if response is not successful or doesn't match pattern
 *
 * @example
 * ```typescript
 * const result = await client.registerChannel('#test');
 * assertServiceSuccess(result, /registered|created/i);
 * ```
 */
export function assertServiceSuccess(
  result: ServiceResponse,
  expectedPattern?: RegExp
): void {
  expect(result.success, `Expected service command to succeed. Error: ${result.error || 'unknown'}`).toBe(true);
  expect(result.lines.length, 'Expected at least one response line').toBeGreaterThan(0);

  if (expectedPattern) {
    const matchFound = result.lines.some(line => expectedPattern.test(line));
    expect(
      matchFound,
      `Expected response to match ${expectedPattern}. Got: ${result.lines.join(' | ')}`
    ).toBe(true);
  }
}

/**
 * Assert that a service response indicates failure.
 *
 * @param result - Service response to validate
 * @param expectedPattern - Optional regex to match against error message
 * @throws AssertionError if response is successful or doesn't match pattern
 *
 * @example
 * ```typescript
 * const result = await unprivilegedClient.forceJoin('victim', '#channel');
 * assertServiceError(result, /insufficient|privilege|denied/i);
 * ```
 */
export function assertServiceError(
  result: ServiceResponse,
  expectedPattern?: RegExp
): void {
  expect(result.success, `Expected service command to fail, but it succeeded`).toBe(false);

  if (expectedPattern) {
    const allText = result.error
      ? result.error
      : result.lines.join(' ');

    expect(
      expectedPattern.test(allText),
      `Expected error to match ${expectedPattern}. Got: ${allText}`
    ).toBe(true);
  }
}

/**
 * Assert that an array contains at least one item matching a predicate.
 *
 * Replaces the weak pattern:
 *   const item = array.find(predicate);
 *   expect(item).toBeDefined();
 *
 * With a stronger assertion that returns the found item for further checks.
 *
 * @param array - Array to search
 * @param predicate - Function to match items
 * @param message - Optional assertion message
 * @returns The first matching item
 * @throws AssertionError if no item matches
 *
 * @example
 * ```typescript
 * const accessList = await client.getAccess('#channel');
 * const owner = assertHasMatchingItem(
 *   accessList,
 *   e => e.level >= 500,
 *   'Expected channel to have an owner'
 * );
 * expect(owner.account).toBe('expectedOwner');
 * ```
 */
export function assertHasMatchingItem<T>(
  array: T[],
  predicate: (item: T) => boolean,
  message?: string
): T {
  const item = array.find(predicate);
  expect(
    item,
    message || `Expected array to contain matching item. Array: ${JSON.stringify(array)}`
  ).toBeDefined();
  return item!;
}

/**
 * Assert that an array contains no items matching a predicate.
 *
 * @param array - Array to search
 * @param predicate - Function to match items
 * @param message - Optional assertion message
 * @throws AssertionError if any item matches
 */
export function assertNoMatchingItem<T>(
  array: T[],
  predicate: (item: T) => boolean,
  message?: string
): void {
  const item = array.find(predicate);
  expect(
    item,
    message || `Expected array to contain no matching items. Found: ${JSON.stringify(item)}`
  ).toBeUndefined();
}

/**
 * Expected message structure for assertMessage.
 */
export interface ExpectedMessage {
  /** Expected command (exact match) */
  command?: string;
  /** Expected parameters (exact or regex match per position) */
  params?: (string | RegExp | undefined)[];
  /** Expected tags (exact or regex match) */
  tags?: Record<string, string | RegExp | undefined>;
  /** Expected source nick (exact match) */
  sourceNick?: string;
}

/**
 * Assert that an IRC message matches expected structure.
 *
 * Replaces the weak pattern:
 *   expect(msg).toBeDefined();
 *   expect(msg.command).toBe('PRIVMSG');
 *
 * With a comprehensive assertion.
 *
 * @param msg - IRC message to validate
 * @param expected - Expected message structure
 * @throws AssertionError if message doesn't match expected structure
 *
 * @example
 * ```typescript
 * const msg = await client.waitForParsedLine(m => m.command === 'MARKREAD');
 * assertMessage(msg, {
 *   command: 'MARKREAD',
 *   params: ['#channel', /timestamp=\d+/],
 *   tags: { 'time': /^\d{4}-\d{2}-\d{2}T/ }
 * });
 * ```
 */
export function assertMessage(
  msg: IRCMessage,
  expected: ExpectedMessage
): void {
  expect(msg, 'Expected message to be defined').toBeDefined();

  if (expected.command !== undefined) {
    expect(msg.command, `Expected command ${expected.command}`).toBe(expected.command);
  }

  if (expected.sourceNick !== undefined) {
    expect(msg.source?.nick, `Expected source nick ${expected.sourceNick}`).toBe(expected.sourceNick);
  }

  if (expected.params !== undefined) {
    for (let i = 0; i < expected.params.length; i++) {
      const expectedParam = expected.params[i];
      if (expectedParam === undefined) continue;

      const actualParam = msg.params[i];
      expect(actualParam, `Expected param[${i}] to exist`).toBeDefined();

      if (expectedParam instanceof RegExp) {
        expect(
          expectedParam.test(actualParam),
          `Expected param[${i}] to match ${expectedParam}. Got: ${actualParam}`
        ).toBe(true);
      } else {
        expect(actualParam, `Expected param[${i}] = ${expectedParam}`).toBe(expectedParam);
      }
    }
  }

  if (expected.tags !== undefined) {
    for (const [key, expectedValue] of Object.entries(expected.tags)) {
      if (expectedValue === undefined) continue;

      const actualValue = msg.tags[key];
      expect(actualValue, `Expected tag '${key}' to exist`).toBeDefined();

      if (expectedValue instanceof RegExp) {
        expect(
          expectedValue.test(actualValue),
          `Expected tag '${key}' to match ${expectedValue}. Got: ${actualValue}`
        ).toBe(true);
      } else {
        expect(actualValue, `Expected tag '${key}' = ${expectedValue}`).toBe(expectedValue);
      }
    }
  }
}

/**
 * Assert that an IRC message is a specific numeric reply.
 *
 * @param msg - IRC message to validate
 * @param numeric - Expected numeric (e.g., '001', '433', '903')
 * @param paramsPattern - Optional patterns for params
 *
 * @example
 * ```typescript
 * const welcome = await client.waitForNumeric('001');
 * assertNumericReply(welcome, '001', [undefined, /Welcome/]);
 * ```
 */
export function assertNumericReply(
  msg: IRCMessage,
  numeric: string,
  paramsPattern?: (string | RegExp | undefined)[]
): void {
  expect(msg.command, `Expected numeric ${numeric}`).toBe(numeric);

  if (paramsPattern) {
    for (let i = 0; i < paramsPattern.length; i++) {
      const pattern = paramsPattern[i];
      if (pattern === undefined) continue;

      const actual = msg.params[i];
      if (pattern instanceof RegExp) {
        expect(pattern.test(actual), `Expected param[${i}] to match ${pattern}`).toBe(true);
      } else {
        expect(actual).toBe(pattern);
      }
    }
  }
}

/**
 * Assert that lines contain expected content.
 *
 * Replaces the weak pattern:
 *   expect(lines.length).toBeGreaterThan(0);
 *
 * With content validation.
 *
 * @param lines - Array of lines to check
 * @param expectedPatterns - Patterns that should be found (at least one match each)
 *
 * @example
 * ```typescript
 * const lines = await collectMultipleLines(client, /353/, /366/);
 * assertLinesContain(lines, [/testuser/, /testchannel/]);
 * ```
 */
export function assertLinesContain(
  lines: string[],
  expectedPatterns: RegExp[]
): void {
  expect(lines.length, 'Expected at least one line').toBeGreaterThan(0);

  for (const pattern of expectedPatterns) {
    const found = lines.some(line => pattern.test(line));
    expect(
      found,
      `Expected lines to contain match for ${pattern}. Lines: ${lines.join(' | ')}`
    ).toBe(true);
  }
}

/**
 * Assert that a batch was received and has expected structure.
 *
 * @param batch - Batch object from waitForBatch
 * @param expectedType - Expected batch type
 * @param minMessages - Minimum expected messages (default 0)
 *
 * @example
 * ```typescript
 * const batch = await client.waitForBatch('chathistory');
 * assertBatchValid(batch, 'chathistory', 5);
 * ```
 */
export function assertBatchValid(
  batch: { type: string; messages: IRCMessage[] } | null | undefined,
  expectedType: string,
  minMessages: number = 0
): void {
  expect(batch, `Expected batch to exist`).toBeDefined();
  expect(batch!.type, `Expected batch type ${expectedType}`).toBe(expectedType);
  expect(
    batch!.messages.length,
    `Expected at least ${minMessages} messages in batch`
  ).toBeGreaterThanOrEqual(minMessages);
}

/**
 * Assert response is not an error numeric.
 *
 * Useful when you want to verify a command succeeded without
 * checking for specific success indicators.
 *
 * @param msg - IRC message to check
 * @param context - Description of what was being attempted
 */
export function assertNotError(
  msg: IRCMessage,
  context?: string
): void {
  const errorNumerics = [
    '400', '401', '402', '403', '404', '405', '406', '407', '408', '409',
    '411', '412', '413', '414', '415', '421', '422', '423', '424',
    '431', '432', '433', '436', '437', '441', '442', '443', '444', '445', '446',
    '451', '461', '462', '463', '464', '465', '466', '467',
    '471', '472', '473', '474', '475', '476', '477', '478',
    '481', '482', '483', '484', '485', '491',
    '501', '502',
  ];

  expect(
    errorNumerics.includes(msg.command),
    `${context ? context + ': ' : ''}Received error ${msg.command}: ${msg.params.join(' ')}`
  ).toBe(false);
}
