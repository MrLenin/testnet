/**
 * IRC Message Parser
 *
 * Provides structured parsing and validation for IRC messages.
 * Follows the IRCv3 message format with support for tags.
 *
 * Message format: [@tags] [:source] <command> [params...] [:trailing]
 */

/**
 * Parsed IRC message source (nick!user@host).
 */
export interface MessageSource {
  nick: string;
  user: string | null;
  host: string | null;
  /** Full source string as received */
  raw: string;
}

/**
 * Parsed IRC message with all components.
 */
export interface ParsedMessage {
  /** IRCv3 message tags (key-value pairs) */
  tags: Map<string, string>;
  /** Message source (nick!user@host) or null if not present */
  source: MessageSource | null;
  /** IRC command (e.g., PRIVMSG, JOIN, 001) */
  command: string;
  /** Command parameters (not including trailing) */
  params: string[];
  /** Raw message line */
  raw: string;
}

/**
 * Parse an IRC message line into structured components.
 *
 * Handles IRCv3 tags, source prefix, command, and parameters.
 *
 * @example
 * parseIRCMessage('@time=2024-01-01T00:00:00Z :nick!user@host PRIVMSG #channel :Hello world')
 * // Returns: { tags: Map { 'time' => '2024-01-01T00:00:00Z' }, source: { nick: 'nick', ... }, command: 'PRIVMSG', params: ['#channel', 'Hello world'] }
 */
export function parseIRCMessage(line: string): ParsedMessage {
  const raw = line;
  let pos = 0;

  // Parse tags (IRCv3)
  const tags = new Map<string, string>();
  if (line.startsWith('@')) {
    const tagEnd = line.indexOf(' ');
    if (tagEnd === -1) {
      return { tags, source: null, command: line.slice(1), params: [], raw };
    }
    const tagString = line.slice(1, tagEnd);
    for (const tag of tagString.split(';')) {
      const eqPos = tag.indexOf('=');
      if (eqPos === -1) {
        tags.set(tag, '');
      } else {
        const key = tag.slice(0, eqPos);
        const value = unescapeTagValue(tag.slice(eqPos + 1));
        tags.set(key, value);
      }
    }
    pos = tagEnd + 1;
    // Skip additional spaces
    while (line[pos] === ' ') pos++;
  }

  // Parse source
  let source: MessageSource | null = null;
  if (line[pos] === ':') {
    const sourceEnd = line.indexOf(' ', pos);
    if (sourceEnd === -1) {
      return { tags, source: null, command: line.slice(pos + 1), params: [], raw };
    }
    source = parseSource(line.slice(pos + 1, sourceEnd));
    pos = sourceEnd + 1;
    while (line[pos] === ' ') pos++;
  }

  // Parse command
  const commandEnd = line.indexOf(' ', pos);
  let command: string;
  if (commandEnd === -1) {
    command = line.slice(pos);
    return { tags, source, command, params: [], raw };
  }
  command = line.slice(pos, commandEnd);
  pos = commandEnd + 1;
  while (line[pos] === ' ') pos++;

  // Parse parameters
  const params: string[] = [];
  while (pos < line.length) {
    if (line[pos] === ':') {
      // Trailing parameter (rest of line)
      params.push(line.slice(pos + 1));
      break;
    }
    const paramEnd = line.indexOf(' ', pos);
    if (paramEnd === -1) {
      params.push(line.slice(pos));
      break;
    }
    params.push(line.slice(pos, paramEnd));
    pos = paramEnd + 1;
    while (line[pos] === ' ') pos++;
  }

  return { tags, source, command, params, raw };
}

/**
 * Parse a source string (nick!user@host) into components.
 */
function parseSource(source: string): MessageSource {
  const raw = source;
  const bangPos = source.indexOf('!');
  const atPos = source.indexOf('@');

  if (bangPos === -1 && atPos === -1) {
    return { nick: source, user: null, host: null, raw };
  }

  if (bangPos !== -1 && atPos !== -1 && bangPos < atPos) {
    return {
      nick: source.slice(0, bangPos),
      user: source.slice(bangPos + 1, atPos),
      host: source.slice(atPos + 1),
      raw,
    };
  }

  if (atPos !== -1) {
    return {
      nick: source.slice(0, atPos),
      user: null,
      host: source.slice(atPos + 1),
      raw,
    };
  }

  return { nick: source.slice(0, bangPos), user: source.slice(bangPos + 1), host: null, raw };
}

/**
 * Unescape IRCv3 tag values.
 */
function unescapeTagValue(value: string): string {
  return value
    .replace(/\\:/g, ';')
    .replace(/\\s/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Assert that a message is a PRIVMSG with expected properties.
 *
 * @throws Error if validation fails
 */
export function assertPrivmsg(
  msg: ParsedMessage,
  options: {
    sender?: string;
    target?: string;
    text?: string | RegExp;
    hasTag?: string;
  }
): void {
  if (msg.command !== 'PRIVMSG') {
    throw new Error(`Expected PRIVMSG, got ${msg.command}`);
  }

  if (options.sender && msg.source?.nick !== options.sender) {
    throw new Error(`Expected sender '${options.sender}', got '${msg.source?.nick}'`);
  }

  if (options.target && msg.params[0] !== options.target) {
    throw new Error(`Expected target '${options.target}', got '${msg.params[0]}'`);
  }

  if (options.text) {
    const text = msg.params[1] || '';
    if (typeof options.text === 'string') {
      if (!text.includes(options.text)) {
        throw new Error(`Expected text to contain '${options.text}', got '${text}'`);
      }
    } else {
      if (!options.text.test(text)) {
        throw new Error(`Expected text to match ${options.text}, got '${text}'`);
      }
    }
  }

  if (options.hasTag && !msg.tags.has(options.hasTag)) {
    throw new Error(`Expected tag '${options.hasTag}' not found`);
  }
}

/**
 * Assert that a message is a specific numeric reply.
 *
 * @throws Error if validation fails
 */
export function assertNumeric(
  msg: ParsedMessage,
  numeric: number | string,
  options?: {
    params?: (string | RegExp | null)[];
  }
): void {
  const expectedNumeric = String(numeric).padStart(3, '0');
  if (msg.command !== expectedNumeric && msg.command !== String(numeric)) {
    throw new Error(`Expected numeric ${expectedNumeric}, got ${msg.command}`);
  }

  if (options?.params) {
    for (let i = 0; i < options.params.length; i++) {
      const expected = options.params[i];
      if (expected === null) continue;

      const actual = msg.params[i];
      if (typeof expected === 'string') {
        if (actual !== expected) {
          throw new Error(`Param ${i}: expected '${expected}', got '${actual}'`);
        }
      } else {
        if (!expected.test(actual || '')) {
          throw new Error(`Param ${i}: expected to match ${expected}, got '${actual}'`);
        }
      }
    }
  }
}

/**
 * Assert that a message is a JOIN with expected properties.
 */
export function assertJoin(
  msg: ParsedMessage,
  options: {
    nick?: string;
    channel?: string;
    account?: string; // For extended-join
  }
): void {
  if (msg.command !== 'JOIN') {
    throw new Error(`Expected JOIN, got ${msg.command}`);
  }

  if (options.nick && msg.source?.nick !== options.nick) {
    throw new Error(`Expected nick '${options.nick}', got '${msg.source?.nick}'`);
  }

  if (options.channel && msg.params[0] !== options.channel) {
    throw new Error(`Expected channel '${options.channel}', got '${msg.params[0]}'`);
  }

  // Extended-join: JOIN #channel accountname :realname
  if (options.account && msg.params[1] !== options.account) {
    throw new Error(`Expected account '${options.account}', got '${msg.params[1]}'`);
  }
}

/**
 * Assert that a message is a MODE with expected properties.
 */
export function assertMode(
  msg: ParsedMessage,
  options: {
    target?: string;
    modes?: string;
    args?: string[];
  }
): void {
  if (msg.command !== 'MODE') {
    throw new Error(`Expected MODE, got ${msg.command}`);
  }

  if (options.target && msg.params[0] !== options.target) {
    throw new Error(`Expected target '${options.target}', got '${msg.params[0]}'`);
  }

  if (options.modes && msg.params[1] !== options.modes) {
    throw new Error(`Expected modes '${options.modes}', got '${msg.params[1]}'`);
  }

  if (options.args) {
    const actualArgs = msg.params.slice(2);
    for (let i = 0; i < options.args.length; i++) {
      if (actualArgs[i] !== options.args[i]) {
        throw new Error(`Mode arg ${i}: expected '${options.args[i]}', got '${actualArgs[i]}'`);
      }
    }
  }
}

/**
 * Assert that a message is a KICK with expected properties.
 */
export function assertKick(
  msg: ParsedMessage,
  options: {
    channel?: string;
    kicked?: string;
    by?: string;
    reason?: string | RegExp;
  }
): void {
  if (msg.command !== 'KICK') {
    throw new Error(`Expected KICK, got ${msg.command}`);
  }

  if (options.channel && msg.params[0] !== options.channel) {
    throw new Error(`Expected channel '${options.channel}', got '${msg.params[0]}'`);
  }

  if (options.kicked && msg.params[1] !== options.kicked) {
    throw new Error(`Expected kicked user '${options.kicked}', got '${msg.params[1]}'`);
  }

  if (options.by && msg.source?.nick !== options.by) {
    throw new Error(`Expected kicked by '${options.by}', got '${msg.source?.nick}'`);
  }

  if (options.reason) {
    const reason = msg.params[2] || '';
    if (typeof options.reason === 'string') {
      if (!reason.includes(options.reason)) {
        throw new Error(`Expected reason to contain '${options.reason}', got '${reason}'`);
      }
    } else {
      if (!options.reason.test(reason)) {
        throw new Error(`Expected reason to match ${options.reason}, got '${reason}'`);
      }
    }
  }
}

/**
 * Assert that a message has a specific tag with optional value check.
 */
export function assertTag(
  msg: ParsedMessage,
  tagName: string,
  expectedValue?: string | RegExp
): void {
  if (!msg.tags.has(tagName)) {
    throw new Error(`Expected tag '${tagName}' not found. Tags: ${Array.from(msg.tags.keys()).join(', ')}`);
  }

  if (expectedValue !== undefined) {
    const actual = msg.tags.get(tagName)!;
    if (typeof expectedValue === 'string') {
      if (actual !== expectedValue) {
        throw new Error(`Tag '${tagName}': expected '${expectedValue}', got '${actual}'`);
      }
    } else {
      if (!expectedValue.test(actual)) {
        throw new Error(`Tag '${tagName}': expected to match ${expectedValue}, got '${actual}'`);
      }
    }
  }
}

/**
 * Check if a message is a specific command (non-throwing).
 */
export function isCommand(msg: ParsedMessage, command: string): boolean {
  return msg.command.toUpperCase() === command.toUpperCase();
}

/**
 * Check if a message is a numeric reply (non-throwing).
 */
export function isNumeric(msg: ParsedMessage, numeric: number | string): boolean {
  const expected = String(numeric).padStart(3, '0');
  return msg.command === expected || msg.command === String(numeric);
}

/**
 * Extract the text content from a PRIVMSG/NOTICE.
 */
export function getMessageText(msg: ParsedMessage): string | null {
  if (msg.command !== 'PRIVMSG' && msg.command !== 'NOTICE') {
    return null;
  }
  return msg.params[1] || null;
}

/**
 * Get the server-time tag as a Date, if present.
 */
export function getServerTime(msg: ParsedMessage): Date | null {
  const timeTag = msg.tags.get('time');
  if (!timeTag) return null;
  const date = new Date(timeTag);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Get the msgid tag, if present.
 */
export function getMsgId(msg: ParsedMessage): string | null {
  return msg.tags.get('msgid') || null;
}

/**
 * Get the account tag, if present.
 */
export function getAccount(msg: ParsedMessage): string | null {
  return msg.tags.get('account') || null;
}

// ============================================================================
// Batch Helpers
// ============================================================================

/**
 * Parse a BATCH start message and return the batch ID and type.
 */
export function parseBatchStart(msg: ParsedMessage): { id: string; type: string; params: string[] } | null {
  if (msg.command !== 'BATCH') return null;
  if (!msg.params[0]?.startsWith('+')) return null;

  const id = msg.params[0].slice(1);
  const type = msg.params[1] || '';
  const params = msg.params.slice(2);

  return { id, type, params };
}

/**
 * Check if a message is a BATCH end.
 */
export function isBatchEnd(msg: ParsedMessage, batchId?: string): boolean {
  if (msg.command !== 'BATCH') return false;
  if (!msg.params[0]?.startsWith('-')) return false;
  if (batchId && msg.params[0] !== `-${batchId}`) return false;
  return true;
}

/**
 * Get the batch ID from a message's batch tag.
 */
export function getBatchId(msg: ParsedMessage): string | null {
  return msg.tags.get('batch') || null;
}
