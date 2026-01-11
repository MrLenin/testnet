import { Client } from 'irc-framework';
import { Socket } from 'net';

export interface IRCv3Config {
  host: string;
  port: number;
  nick: string;
  username?: string;
  gecos?: string;
  tls?: boolean;
  sasl_user?: string;
  sasl_pass?: string;
  request_caps?: string[];
}

export interface RawEvent {
  from_server: boolean;
  line: string;
  tags: Record<string, string>;
}

export interface CapState {
  available: Map<string, string | null>;
  enabled: Set<string>;
  pending: boolean;
}

/**
 * Parsed IRC message structure.
 * Properly represents all components of an IRC message per RFC 1459 + IRCv3 extensions.
 */
export interface IRCMessage {
  /** Raw line as received */
  raw: string;
  /** IRCv3 message tags (e.g., time, msgid) */
  tags: Record<string, string>;
  /** Message source (nick!user@host) */
  source: {
    nick: string;
    user?: string;
    host?: string;
    /** Full prefix string */
    full: string;
  } | null;
  /** IRC command (PRIVMSG, NOTICE, JOIN, etc.) */
  command: string;
  /** Command parameters */
  params: string[];
  /** Trailing parameter (after :) - also in params but convenient */
  trailing?: string;
}

/**
 * Parse an IRC message line into structured components.
 * Handles IRCv3 message tags, source prefix, command, and parameters.
 *
 * Format: [@tags] [:source] COMMAND [params] [:trailing]
 *
 * Examples:
 *   :server 001 nick :Welcome
 *   :nick!user@host PRIVMSG #channel :Hello world
 *   @time=2024-01-01T00:00:00Z :AuthServ!AuthServ@x3.services NOTICE nick :Message
 */
export function parseIRCMessage(line: string): IRCMessage {
  const result: IRCMessage = {
    raw: line,
    tags: {},
    source: null,
    command: '',
    params: [],
  };

  let pos = 0;

  // Parse tags (if present)
  if (line.startsWith('@')) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) {
      result.command = line.substring(1);
      return result;
    }
    const tagStr = line.substring(1, spaceIdx);
    for (const tag of tagStr.split(';')) {
      const eqIdx = tag.indexOf('=');
      if (eqIdx === -1) {
        result.tags[tag] = '';
      } else {
        // Unescape tag values per IRCv3 spec
        let value = tag.substring(eqIdx + 1);
        value = value
          .replace(/\\:/g, ';')
          .replace(/\\s/g, ' ')
          .replace(/\\r/g, '\r')
          .replace(/\\n/g, '\n')
          .replace(/\\\\/g, '\\');
        result.tags[tag.substring(0, eqIdx)] = value;
      }
    }
    pos = spaceIdx + 1;
  }

  // Skip leading spaces
  while (line[pos] === ' ') pos++;

  // Parse source (if present)
  if (line[pos] === ':') {
    const spaceIdx = line.indexOf(' ', pos);
    if (spaceIdx === -1) {
      result.command = line.substring(pos + 1);
      return result;
    }
    const sourceStr = line.substring(pos + 1, spaceIdx);
    result.source = parseSource(sourceStr);
    pos = spaceIdx + 1;
  }

  // Skip leading spaces
  while (line[pos] === ' ') pos++;

  // Parse command and params
  const rest = line.substring(pos);
  const parts = rest.split(' ');

  // First non-empty part is the command
  let cmdIdx = 0;
  while (cmdIdx < parts.length && parts[cmdIdx] === '') cmdIdx++;
  if (cmdIdx < parts.length) {
    result.command = parts[cmdIdx].toUpperCase();
    cmdIdx++;
  }

  // Remaining parts are params, with : indicating trailing
  for (let i = cmdIdx; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      // Everything from here is the trailing param
      const trailing = parts.slice(i).join(' ').substring(1);
      result.params.push(trailing);
      result.trailing = trailing;
      break;
    } else if (parts[i] !== '') {
      result.params.push(parts[i]);
    }
  }

  return result;
}

/**
 * Parse a source prefix (nick!user@host) into components.
 */
function parseSource(source: string): IRCMessage['source'] {
  const bangIdx = source.indexOf('!');
  const atIdx = source.indexOf('@');

  if (bangIdx === -1 && atIdx === -1) {
    // Just a server name or nick
    return { nick: source, full: source };
  }

  if (bangIdx !== -1 && atIdx !== -1 && atIdx > bangIdx) {
    // Full nick!user@host
    return {
      nick: source.substring(0, bangIdx),
      user: source.substring(bangIdx + 1, atIdx),
      host: source.substring(atIdx + 1),
      full: source,
    };
  }

  if (bangIdx !== -1) {
    // nick!user (no host)
    return {
      nick: source.substring(0, bangIdx),
      user: source.substring(bangIdx + 1),
      full: source,
    };
  }

  // nick@host (no user) - unusual but possible
  return {
    nick: source.substring(0, atIdx),
    host: source.substring(atIdx + 1),
    full: source,
  };
}

/**
 * Check if a parsed message is from a specific service.
 */
export function isFromService(msg: IRCMessage, service: string): boolean {
  if (!msg.source) return false;
  return msg.source.nick.toLowerCase() === service.toLowerCase();
}

/**
 * Check if a parsed message is a NOTICE from a specific service.
 */
export function isServiceNotice(msg: IRCMessage, service: string): boolean {
  return msg.command === 'NOTICE' && isFromService(msg, service);
}

/**
 * A line with both raw and parsed representations.
 * Parsing is done once on arrival for efficiency.
 */
export interface ParsedLine {
  raw: string;
  parsed: IRCMessage;
}

/**
 * IRCv3-aware test client with CAP negotiation support.
 * Provides fine-grained control for testing CAP, SASL, and other IRCv3 features.
 */
export class IRCv3TestClient {
  private client: Client;
  private rawBuffer: string[] = [];
  private connected = false;
  private registered = false;
  private capState: CapState = {
    available: new Map(),
    enabled: new Set(),
    pending: false,
  };

  constructor() {
    this.client = new Client();

    // Buffer all raw messages for debugging and assertions
    this.client.on('raw', (event: RawEvent) => {
      this.rawBuffer.push(event.line);
    });
  }

  /**
   * Connect without automatic CAP negotiation.
   * Allows manual CAP LS/REQ testing.
   */
  async connectRaw(config: IRCv3Config): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${config.host}:${config.port}`));
      }, 10000);

      // Disable irc-framework's automatic CAP handling
      this.client.connect({
        host: config.host,
        port: config.port,
        nick: config.nick,
        username: config.username ?? config.nick,
        gecos: config.gecos ?? 'IRCv3 Test Client',
        tls: config.tls ?? false,
        auto_reconnect: false,
        enable_cap: false, // Disable automatic CAP
      });

      this.client.once('socket connected', () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.client.once('close', () => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error('Connection closed before socket connected'));
        }
      });
    });
  }

  /**
   * Connect with automatic CAP negotiation and optional SASL.
   */
  async connect(config: IRCv3Config): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${config.host}:${config.port}`));
      }, 15000);

      const connectOpts: Record<string, unknown> = {
        host: config.host,
        port: config.port,
        nick: config.nick,
        username: config.username ?? config.nick,
        gecos: config.gecos ?? 'IRCv3 Test Client',
        tls: config.tls ?? false,
        auto_reconnect: false,
        enable_cap: true,
      };

      // Add SASL credentials if provided
      if (config.sasl_user && config.sasl_pass) {
        connectOpts.account = {
          account: config.sasl_user,
          password: config.sasl_pass,
        };
      }

      this.client.connect(connectOpts);

      this.client.once('registered', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.registered = true;
        resolve();
      });

      this.client.once('close', () => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error('Connection closed before registration'));
        }
      });
    });
  }

  /**
   * Send CAP LS and parse available capabilities.
   */
  async capLs(version = 302): Promise<Map<string, string | null>> {
    this.raw(`CAP LS ${version}`);
    this.capState.pending = true;

    // Wait for CAP LS response (may be multiline with *)
    let done = false;
    while (!done) {
      let response = await this.waitForRaw(/^:\S+ CAP \S+ LS/i);
      // Trim trailing CRLF/whitespace
      response = response.replace(/[\r\n]+$/, '');

      // Parse capabilities from response
      // Format: :server CAP nick LS [*] :cap1 cap2=value cap3
      const match = response.match(/CAP \S+ LS( \*)? :(.+)$/i);
      if (match) {
        const caps = match[2].split(' ');
        for (const cap of caps) {
          // Only split on first = to preserve value (e.g., draft/multiline=max-bytes=4096,max-lines=24)
          const eqIndex = cap.indexOf('=');
          const name = eqIndex === -1 ? cap : cap.substring(0, eqIndex);
          const value = eqIndex === -1 ? null : cap.substring(eqIndex + 1);
          this.capState.available.set(name, value);
        }
        // If no *, this is the final line
        done = !match[1];
      } else {
        done = true;
      }
    }

    this.capState.pending = false;
    return this.capState.available;
  }

  /**
   * Request specific capabilities.
   */
  async capReq(caps: string[]): Promise<{ ack: string[]; nak: string[] }> {
    this.raw(`CAP REQ :${caps.join(' ')}`);

    // Server may send multiple CAP responses (e.g., cap-notify auto-ACKs)
    // We need to collect all ACK/NAK responses and find our requested caps
    const ackCaps: string[] = [];
    const nakCaps: string[] = [];
    const requestedSet = new Set(caps.map(c => c.toLowerCase().replace(/^-/, '')));
    let foundResponse = false;

    // Wait for responses with a timeout
    const startTime = Date.now();
    const timeout = 5000;

    while (!foundResponse && Date.now() - startTime < timeout) {
      try {
        let response = await this.waitForRaw(/^:\S+ CAP \S+ (ACK|NAK)/i, 1000, true);
        // Trim trailing CRLF/whitespace
        response = response.replace(/[\r\n]+$/, '');

        // Try both formats: with and without colon before caps
        let match = response.match(/CAP \S+ (ACK|NAK) :(.*)$/i);
        if (!match) {
          match = response.match(/CAP \S+ (ACK|NAK) (.*)$/i);
        }

        if (match) {
          const type = match[1].toUpperCase();
          const respondedCaps = match[2].split(' ').filter(c => c);

          for (const cap of respondedCaps) {
            const capName = cap.toLowerCase().replace(/^-/, '');
            if (type === 'ACK') {
              // Handle -cap (disabled) vs cap (enabled)
              if (cap.startsWith('-')) {
                this.capState.enabled.delete(cap.substring(1));
              } else {
                this.capState.enabled.add(cap);
              }
              ackCaps.push(cap);
            } else {
              nakCaps.push(cap);
            }

            // Check if this response includes any of our requested caps
            if (requestedSet.has(capName)) {
              foundResponse = true;
            }
          }
        }
      } catch {
        // Timeout waiting for more responses, break out
        break;
      }
    }

    // If we didn't find our specific caps, but got ACK responses,
    // the requested caps might be in there (some servers ACK all at once)
    if (!foundResponse && ackCaps.length > 0) {
      foundResponse = true;
    }

    return { ack: ackCaps, nak: nakCaps };
  }

  /**
   * End CAP negotiation.
   */
  capEnd(): void {
    this.raw('CAP END');
  }

  /**
   * Perform SASL PLAIN authentication manually.
   */
  async saslPlain(user: string, pass: string): Promise<boolean> {
    this.raw('AUTHENTICATE PLAIN');

    await this.waitForRaw(/^AUTHENTICATE \+$/);

    // SASL PLAIN format: base64(authzid\0authcid\0password)
    const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');
    this.raw(`AUTHENTICATE ${payload}`);

    // Wait for result
    try {
      await this.waitForRaw(/^:\S+ 903/); // RPL_SASLSUCCESS
      return true;
    } catch {
      // Check for failure
      const hasFailure = this.rawBuffer.some(
        line => /^:\S+ (902|904|905|906)/.test(line)
      );
      if (hasFailure) {
        return false;
      }
      throw new Error('SASL authentication timed out');
    }
  }

  /**
   * Send NICK and USER commands for manual registration.
   */
  register(nick: string, user?: string, gecos?: string): void {
    this.raw(`NICK ${nick}`);
    this.raw(`USER ${user ?? nick} 0 * :${gecos ?? 'Test User'}`);
  }

  /**
   * Wait for a specific event.
   */
  async waitForEvent<T = unknown>(event: string, timeout = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeout);

      this.client.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /**
   * Wait for a raw message matching a pattern.
   * Set consumeFromBuffer=true to remove the matched line from buffer (useful for loops).
   */
  async waitForRaw(pattern: string | RegExp, timeout = 5000, consumeFromBuffer = false): Promise<string> {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for raw pattern: ${pattern}\nLast 20 lines:\n${this.rawBuffer.slice(-20).join('\n')}`
          )
        );
      }, timeout);

      // Check existing buffer first
      for (let i = 0; i < this.rawBuffer.length; i++) {
        if (regex.test(this.rawBuffer[i])) {
          clearTimeout(timer);
          const line = this.rawBuffer[i];
          if (consumeFromBuffer) {
            this.rawBuffer.splice(i, 1);
          }
          resolve(line);
          return;
        }
      }

      // Listen for new messages
      const handler = (event: RawEvent) => {
        if (regex.test(event.line)) {
          clearTimeout(timer);
          this.client.removeListener('raw', handler);
          resolve(event.line);
        }
      };

      this.client.on('raw', handler);
    });
  }

  /**
   * Collect all raw messages matching a pattern until timeout or stop pattern.
   */
  async collectRaw(
    pattern: string | RegExp,
    options: { timeout?: number; stopPattern?: RegExp; maxLines?: number } = {}
  ): Promise<string[]> {
    const { timeout = 2000, stopPattern, maxLines = 100 } = options;
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const collected: string[] = [];

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client.removeListener('raw', handler);
        resolve(collected);
      }, timeout);

      const handler = (event: RawEvent) => {
        if (regex.test(event.line)) {
          collected.push(event.line);
          if (collected.length >= maxLines) {
            clearTimeout(timer);
            this.client.removeListener('raw', handler);
            resolve(collected);
          }
        }
        if (stopPattern && stopPattern.test(event.line)) {
          clearTimeout(timer);
          this.client.removeListener('raw', handler);
          resolve(collected);
        }
      };

      // Check existing buffer
      for (const line of this.rawBuffer) {
        if (regex.test(line)) {
          collected.push(line);
        }
        if (stopPattern && stopPattern.test(line)) {
          resolve(collected);
          return;
        }
      }

      this.client.on('raw', handler);
    });
  }

  /**
   * Send a raw IRC command.
   */
  raw(command: string): void {
    this.client.raw(command);
  }

  /**
   * Send a raw IRC command with message tags.
   */
  rawWithTags(tags: Record<string, string | null>, command: string): void {
    const tagStr = Object.entries(tags)
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(';');
    this.raw(`@${tagStr} ${command}`);
  }

  /**
   * Join a channel.
   */
  join(channel: string): void {
    this.client.join(channel);
  }

  /**
   * Part a channel.
   */
  part(channel: string, message?: string): void {
    this.raw(message ? `PART ${channel} :${message}` : `PART ${channel}`);
  }

  /**
   * Send a PRIVMSG.
   */
  say(target: string, message: string): void {
    this.client.say(target, message);
  }

  /**
   * Send a NOTICE.
   */
  notice(target: string, message: string): void {
    this.client.notice(target, message);
  }

  /**
   * Change nickname.
   */
  nick(newNick: string): void {
    this.client.changeNick(newNick);
  }

  /**
   * Send QUIT and close connection.
   */
  quit(message?: string): void {
    this.client.quit(message);
  }

  /**
   * Get current CAP state.
   */
  get caps(): CapState {
    return { ...this.capState };
  }

  /**
   * Check if a specific capability is enabled.
   */
  hasCapEnabled(cap: string): boolean {
    return this.capState.enabled.has(cap);
  }

  /**
   * Get all raw messages.
   */
  get rawMessages(): string[] {
    return [...this.rawBuffer];
  }

  /**
   * Clear raw message buffer.
   */
  clearRawBuffer(): void {
    this.rawBuffer = [];
  }

  /**
   * Get the underlying irc-framework client.
   */
  get rawClient(): Client {
    return this.client;
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if registered.
   */
  get isRegistered(): boolean {
    return this.registered;
  }
}

/**
 * Create a connected IRCv3 test client with CAP negotiation.
 */
export async function createIRCv3Client(
  config: Partial<IRCv3Config> & { nick: string }
): Promise<IRCv3TestClient> {
  const client = new IRCv3TestClient();
  await client.connect({
    host: config.host ?? 'nefarious',
    port: config.port ?? 6667,
    nick: config.nick,
    username: config.username,
    gecos: config.gecos,
    tls: config.tls,
    sasl_user: config.sasl_user,
    sasl_pass: config.sasl_pass,
  });
  return client;
}

/**
 * Create an IRCv3 client connected but without registration.
 * Useful for testing manual CAP negotiation.
 */
export async function createRawIRCv3Client(
  config: Partial<IRCv3Config> & { nick: string }
): Promise<IRCv3TestClient> {
  const client = new IRCv3TestClient();
  await client.connectRaw({
    host: config.host ?? 'nefarious',
    port: config.port ?? 6667,
    nick: config.nick,
    username: config.username,
    gecos: config.gecos,
    tls: config.tls,
  });
  return client;
}

/**
 * Pure socket-based IRC client for truly raw protocol testing.
 * Does not use irc-framework at all - just raw TCP socket.
 */
/**
 * Active batch being collected.
 */
export interface ActiveBatch {
  id: string;
  type: string;
  params: string[];
  messages: IRCMessage[];
}

export class RawSocketClient {
  private socket: Socket | null = null;
  private buffer = '';
  private lines: ParsedLine[] = [];
  private lineListeners: Array<(line: string, lineIndex: number) => void> = [];
  private availableCaps = new Map<string, string | null>();
  private enabledCaps = new Set<string>();
  private debug = process.env.DEBUG === '1' || process.env.IRC_DEBUG === '1';
  private clientId = Math.random().toString(36).substring(2, 8);
  private socketClosed = false;
  private dataChunks = 0;

  // BATCH collection
  private activeBatches = new Map<string, ActiveBatch>();
  private completedBatches: ActiveBatch[] = [];

  private log(msg: string, ...args: unknown[]): void {
    if (this.debug) {
      const ts = new Date().toISOString().substring(11, 23);
      console.log(`[${ts}][${this.clientId}] ${msg}`, ...args);
    }
  }

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.log(`Connecting to ${host}:${port}`);

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.log(`Connected`);
        resolve();
      });

      this.socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        this.log(`Socket error: ${err.message}`);
        reject(err);
      });

      this.socket.on('close', () => {
        this.socketClosed = true;
        this.log(`Socket closed`);
      });

      this.socket.on('end', () => {
        this.log(`Socket ended`);
      });

      this.socket.on('data', (data: Buffer) => {
        this.dataChunks++;
        const dataStr = data.toString();
        this.log(`DATA[${this.dataChunks}] received ${data.length} bytes: ${dataStr.substring(0, 200).replace(/\r\n/g, '\\r\\n')}`);

        this.buffer += dataStr;
        const parts = this.buffer.split('\r\n');
        this.buffer = parts.pop() || '';

        for (const line of parts) {
          if (line) {
            // Auto-respond to PING
            if (line.startsWith('PING ')) {
              const pingArg = line.substring(5);
              this.send(`PONG ${pingArg}`);
            }
            // Parse once on arrival, store both raw and parsed
            const parsed = parseIRCMessage(line);
            this.lines.push({ raw: line, parsed });
            const lineIndex = this.lines.length - 1;
            this.log(`LINE[${lineIndex}]: ${line}`);

            // Track batch membership
            const batchTag = parsed.tags?.batch;
            if (batchTag && this.activeBatches.has(batchTag)) {
              this.activeBatches.get(batchTag)!.messages.push(parsed);
            }

            // Handle BATCH start/end
            if (parsed.command === 'BATCH' && parsed.params.length > 0) {
              this.handleBatch(parsed);
            }

            // Notify listeners
            const listenerCount = this.lineListeners.length;
            if (listenerCount > 0) {
              this.log(`Notifying ${listenerCount} listeners`);
            }
            for (const listener of this.lineListeners) {
              listener(line, lineIndex);
            }
          }
        }

        if (this.buffer.length > 0) {
          this.log(`Partial buffer remaining: ${this.buffer.substring(0, 100)}`);
        }
      });

      this.socket.connect(port, host);
    });
  }

  send(line: string): void {
    this.log(`SEND: ${line}`);
    if (this.socketClosed) {
      this.log(`WARNING: Attempting to send on closed socket`);
    }
    this.socket?.write(line + '\r\n');
  }

  /**
   * Handle BATCH start/end commands.
   * Tracks active batches and moves them to completed when done.
   */
  private handleBatch(msg: IRCMessage): void {
    const refTag = msg.params[0];

    if (refTag.startsWith('+')) {
      // BATCH start: +<id> <type> [params...]
      const id = refTag.slice(1);
      const type = msg.params[1] || '';
      const params = msg.params.slice(2);
      this.activeBatches.set(id, { id, type, params, messages: [] });
      this.log(`BATCH start: ${id} type=${type}`);
    } else if (refTag.startsWith('-')) {
      // BATCH end: -<id>
      const id = refTag.slice(1);
      const batch = this.activeBatches.get(id);
      if (batch) {
        this.activeBatches.delete(id);
        this.completedBatches.push(batch);
        this.log(`BATCH end: ${id} with ${batch.messages.length} messages`);
      }
    }
  }

  /**
   * Wait for a completed batch of the specified type.
   * Returns the batch with all its collected messages.
   */
  async waitForBatch(type: string, timeout = 5000): Promise<ActiveBatch> {
    const startTime = Date.now();
    this.log(`waitForBatch: type=${type}, timeout=${timeout}ms`);

    while (Date.now() - startTime < timeout) {
      // Check completed batches
      const idx = this.completedBatches.findIndex(b => b.type === type);
      if (idx !== -1) {
        const batch = this.completedBatches.splice(idx, 1)[0];
        this.log(`waitForBatch: found ${type} batch with ${batch.messages.length} messages`);
        return batch;
      }

      // Wait a bit for more messages
      await new Promise(r => setTimeout(r, 50));
    }

    throw new Error(`Timeout waiting for BATCH type: ${type}`);
  }

  /**
   * Get all completed batches (doesn't consume them).
   */
  get allCompletedBatches(): ActiveBatch[] {
    return [...this.completedBatches];
  }

  /**
   * Clear completed batches.
   */
  clearCompletedBatches(): void {
    this.completedBatches = [];
  }

  private consumedIndices = new Set<number>();

  async waitForLine(pattern: RegExp, timeout = 5000): Promise<string> {
    const waitId = Math.random().toString(36).substring(2, 6);
    this.log(`WAIT[${waitId}] start: pattern=${pattern}, timeout=${timeout}ms, lines=${this.lines.length}, consumed=${this.consumedIndices.size}, listeners=${this.lineListeners.length}`);

    // Helper to find matching unconsumed line in buffer
    const findInBuffer = (): { line: string; index: number } | null => {
      for (let i = 0; i < this.lines.length; i++) {
        if (!this.consumedIndices.has(i) && pattern.test(this.lines[i].raw)) {
          return { line: this.lines[i].raw, index: i };
        }
      }
      return null;
    };

    // Check existing lines first
    const existing = findInBuffer();
    if (existing) {
      this.consumedIndices.add(existing.index);
      this.log(`WAIT[${waitId}] found in buffer at index ${existing.index}: ${existing.line}`);
      return existing.line;
    }

    this.log(`WAIT[${waitId}] not in buffer, registering listener`);

    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        const idx = this.lineListeners.indexOf(handler);
        if (idx >= 0) this.lineListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        cleanup();
        this.log(`WAIT[${waitId}] TIMEOUT after ${timeout}ms, socketClosed=${this.socketClosed}, lines=${this.lines.length}`);
        // Log all unconsumed lines for debugging
        const unconsumed = this.lines.filter((_, i) => !this.consumedIndices.has(i));
        this.log(`WAIT[${waitId}] Unconsumed lines: ${unconsumed.length}`);
        unconsumed.forEach((pl, i) => this.log(`  [${i}] ${pl.raw}`));
        reject(new Error(`Timeout waiting for ${pattern}\nBuffer: ${this.lines.slice(-10).map(l => l.raw).join('\\n')}`));
      }, timeout);

      const handler = (line: string, lineIndex: number) => {
        if (resolved) return;
        if (pattern.test(line)) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          this.consumedIndices.add(lineIndex);
          this.log(`WAIT[${waitId}] matched from listener at index ${lineIndex}: ${line}`);
          resolve(line);
        }
      };

      this.lineListeners.push(handler);
      this.log(`WAIT[${waitId}] listener registered, now ${this.lineListeners.length} listeners`);

      // Re-check buffer after registering listener to catch race condition
      const lateMatch = findInBuffer();
      if (lateMatch && !resolved) {
        resolved = true;
        clearTimeout(timer);
        cleanup();
        this.consumedIndices.add(lateMatch.index);
        this.log(`WAIT[${waitId}] late match in buffer at index ${lateMatch.index}: ${lateMatch.line}`);
        resolve(lateMatch.line);
      }
    });
  }

  /**
   * Wait for a parsed message matching a predicate function.
   * Uses proper IRC message parsing instead of regex on raw strings.
   */
  async waitForParsedLine(predicate: (msg: IRCMessage) => boolean, timeout = 5000): Promise<IRCMessage> {
    const waitId = Math.random().toString(36).substring(2, 6);
    this.log(`WAIT_PARSED[${waitId}] start: timeout=${timeout}ms, lines=${this.lines.length}`);

    // Helper to find matching unconsumed parsed message in buffer
    const findInBuffer = (): { msg: IRCMessage; index: number } | null => {
      for (let i = 0; i < this.lines.length; i++) {
        if (!this.consumedIndices.has(i) && predicate(this.lines[i].parsed)) {
          return { msg: this.lines[i].parsed, index: i };
        }
      }
      return null;
    };

    // Check existing lines first
    const existing = findInBuffer();
    if (existing) {
      this.consumedIndices.add(existing.index);
      this.log(`WAIT_PARSED[${waitId}] found in buffer at index ${existing.index}`);
      return existing.msg;
    }

    this.log(`WAIT_PARSED[${waitId}] not in buffer, registering listener`);

    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        const idx = this.lineListeners.indexOf(handler);
        if (idx >= 0) this.lineListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        cleanup();
        this.log(`WAIT_PARSED[${waitId}] TIMEOUT after ${timeout}ms`);
        reject(new Error(`Timeout waiting for parsed message`));
      }, timeout);

      const handler = (line: string, lineIndex: number) => {
        if (resolved) return;
        const parsed = this.lines[lineIndex].parsed;
        if (predicate(parsed)) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          this.consumedIndices.add(lineIndex);
          this.log(`WAIT_PARSED[${waitId}] matched from listener at index ${lineIndex}`);
          resolve(parsed);
        }
      };

      this.lineListeners.push(handler);

      // Re-check buffer after registering listener to catch race condition
      const lateMatch = findInBuffer();
      if (lateMatch && !resolved) {
        resolved = true;
        clearTimeout(timer);
        cleanup();
        this.consumedIndices.add(lateMatch.index);
        this.log(`WAIT_PARSED[${waitId}] late match in buffer at index ${lateMatch.index}`);
        resolve(lateMatch.msg);
      }
    });
  }

  async collectLines(pattern: RegExp, stopPattern: RegExp, timeout = 5000): Promise<string[]> {
    const collected: string[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const line = await this.waitForLine(pattern, Math.min(1000, timeout - (Date.now() - startTime)));
        collected.push(line);
        if (stopPattern.test(line)) {
          break;
        }
      } catch {
        break;
      }
    }

    return collected;
  }

  get allLines(): string[] {
    return this.lines.map(l => l.raw);
  }

  get allParsedLines(): IRCMessage[] {
    return this.lines.map(l => l.parsed);
  }

  /**
   * Clear the buffer to reset line consumption.
   * This marks all existing lines as consumed so waitForLine only matches new lines.
   */
  clearRawBuffer(): void {
    this.log(`clearRawBuffer: marking ${this.lines.length} lines as consumed`);
    // Mark all current lines as consumed
    for (let i = 0; i < this.lines.length; i++) {
      this.consumedIndices.add(i);
    }
  }

  /**
   * Alias for clearRawBuffer for compatibility.
   */
  clearBuffer(): void {
    this.clearRawBuffer();
  }

  /**
   * Dump current state for debugging.
   */
  dumpState(): void {
    console.log(`[${this.clientId}] State dump:`);
    console.log(`  socketClosed: ${this.socketClosed}`);
    console.log(`  dataChunks: ${this.dataChunks}`);
    console.log(`  lines: ${this.lines.length}`);
    console.log(`  consumed: ${this.consumedIndices.size}`);
    console.log(`  listeners: ${this.lineListeners.length}`);
    console.log(`  pendingBuffer: ${this.buffer.length} chars`);
    console.log(`  All lines:`);
    this.lines.forEach((pl, i) => {
      const consumed = this.consumedIndices.has(i) ? '[C]' : '[ ]';
      console.log(`    ${consumed} [${i}] ${pl.raw.substring(0, 100)}`);
    });
  }

  /**
   * Perform CAP LS and parse capabilities.
   */
  async capLs(version = 302): Promise<Map<string, string | null>> {
    this.send(`CAP LS ${version}`);

    // Collect all CAP LS lines (may be multiline)
    // Pattern matches both pre-registration (CAP * LS) and post-registration (CAP nick LS)
    let done = false;
    while (!done) {
      const line = await this.waitForLine(/CAP \S+ LS/i);

      // Parse capabilities from line
      // Format: :server CAP target LS [*] :cap1 cap2=value cap3
      const match = line.match(/CAP \S+ LS( \*)? :(.+)$/i);
      if (match) {
        const caps = match[2].split(' ');
        for (const cap of caps) {
          const eqIdx = cap.indexOf('=');
          if (eqIdx === -1) {
            this.availableCaps.set(cap, null);
          } else {
            this.availableCaps.set(cap.substring(0, eqIdx), cap.substring(eqIdx + 1));
          }
        }
        // If no *, this is the final line
        done = !match[1];
      } else {
        done = true;
      }
    }

    return this.availableCaps;
  }

  /**
   * Request capabilities and get ACK/NAK response.
   */
  async capReq(caps: string[]): Promise<{ ack: string[]; nak: string[] }> {
    this.send(`CAP REQ :${caps.join(' ')}`);

    // Pattern matches both pre-registration (CAP * ACK/NAK) and post-registration (CAP nick ACK/NAK)
    const response = await this.waitForLine(/CAP \S+ (ACK|NAK)/i);
    const match = response.match(/CAP \S+ (ACK|NAK) :?(.*)$/i);

    const ack: string[] = [];
    const nak: string[] = [];

    if (match) {
      const type = match[1].toUpperCase();
      const respondedCaps = match[2].split(' ').filter(c => c);

      for (const cap of respondedCaps) {
        if (type === 'ACK') {
          if (cap.startsWith('-')) {
            this.enabledCaps.delete(cap.substring(1));
          } else {
            this.enabledCaps.add(cap);
          }
          ack.push(cap);
        } else {
          nak.push(cap);
        }
      }
    }

    return { ack, nak };
  }

  /**
   * Send CAP END.
   */
  capEnd(): void {
    this.send('CAP END');
  }

  /**
   * Register with NICK and USER.
   */
  register(nick: string, user?: string, gecos?: string): void {
    this.send(`NICK ${nick}`);
    this.send(`USER ${user ?? nick} 0 * :${gecos ?? 'Test User'}`);
  }

  /**
   * Check if a capability is enabled.
   */
  hasCapEnabled(cap: string): boolean {
    return this.enabledCaps.has(cap);
  }

  /**
   * Get available capabilities.
   */
  get caps(): Map<string, string | null> {
    return this.availableCaps;
  }

  close(): void {
    this.socket?.destroy();
  }
}

/**
 * Server configuration for multi-server testing.
 */
export interface ServerConfig {
  host: string;
  port: number;
  name: string;
}

/** Primary IRC server (hub) */
export const PRIMARY_SERVER: ServerConfig = {
  host: process.env.IRC_HOST ?? 'nefarious',
  port: 6667,
  name: 'primary',
};

/** Secondary IRC server (leaf) - only available with 'linked' profile */
export const SECONDARY_SERVER: ServerConfig = {
  host: process.env.IRC_HOST2 ?? 'nefarious2',
  port: parseInt(process.env.IRC_PORT2 ?? '6667', 10),
  name: 'secondary',
};

export async function createRawSocketClient(host = PRIMARY_SERVER.host, port = PRIMARY_SERVER.port): Promise<RawSocketClient> {
  const client = new RawSocketClient();
  await client.connect(host, port);
  return client;
}

/**
 * Create a client connected to a specific server.
 */
export async function createClientOnServer(server: ServerConfig): Promise<RawSocketClient> {
  const client = new RawSocketClient();
  await client.connect(server.host, server.port);
  return client;
}

/**
 * Check if the secondary server is available (for skip condition in tests).
 */
export async function isSecondaryServerAvailable(): Promise<boolean> {
  try {
    const client = new RawSocketClient();
    await client.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
    client.close();
    return true;
  } catch {
    return false;
  }
}
