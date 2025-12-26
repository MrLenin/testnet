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
export class RawSocketClient {
  private socket: Socket | null = null;
  private buffer = '';
  private lines: string[] = [];
  private lineListeners: Array<(line: string) => void> = [];
  private availableCaps = new Map<string, string | null>();
  private enabledCaps = new Set<string>();

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.socket.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const parts = this.buffer.split('\r\n');
        this.buffer = parts.pop() || '';
        for (const line of parts) {
          if (line) {
            // Auto-respond to PING
            if (line.startsWith('PING ')) {
              const pingArg = line.substring(5);
              this.send(`PONG ${pingArg}`);
            }
            this.lines.push(line);
            for (const listener of this.lineListeners) {
              listener(line);
            }
          }
        }
      });

      this.socket.connect(port, host);
    });
  }

  send(line: string): void {
    this.socket?.write(line + '\r\n');
  }

  private consumedIndices = new Set<number>();

  async waitForLine(pattern: RegExp, timeout = 5000): Promise<string> {
    // Check existing lines first (skip already consumed ones)
    for (let i = 0; i < this.lines.length; i++) {
      if (!this.consumedIndices.has(i) && pattern.test(this.lines[i])) {
        this.consumedIndices.add(i);
        return this.lines[i];
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.lineListeners.indexOf(handler);
        if (idx >= 0) this.lineListeners.splice(idx, 1);
        reject(new Error(`Timeout waiting for ${pattern}\nBuffer: ${this.lines.slice(-10).join('\\n')}`));
      }, timeout);

      const handler = (line: string) => {
        if (pattern.test(line)) {
          clearTimeout(timer);
          const idx = this.lineListeners.indexOf(handler);
          if (idx >= 0) this.lineListeners.splice(idx, 1);
          // Mark as consumed (it's the last line added)
          this.consumedIndices.add(this.lines.length - 1);
          resolve(line);
        }
      };

      this.lineListeners.push(handler);
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
    return [...this.lines];
  }

  /**
   * Clear the buffer to reset line consumption.
   * This marks all existing lines as consumed so waitForLine only matches new lines.
   */
  clearRawBuffer(): void {
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
  port: 6667,
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
