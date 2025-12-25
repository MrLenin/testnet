import { Client } from 'irc-framework';

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
      const response = await this.waitForRaw(/^:\S+ CAP \S+ LS/i);

      // Parse capabilities from response
      // Format: :server CAP nick LS [*] :cap1 cap2=value cap3
      const match = response.match(/CAP \S+ LS( \*)? :(.+)$/i);
      if (match) {
        const caps = match[2].split(' ');
        for (const cap of caps) {
          const [name, value] = cap.split('=');
          this.capState.available.set(name, value ?? null);
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

    const response = await this.waitForRaw(/^:\S+ CAP \S+ (ACK|NAK)/i);
    const match = response.match(/CAP \S+ (ACK|NAK) :(.*)$/i);

    if (!match) {
      throw new Error(`Invalid CAP response: ${response}`);
    }

    const type = match[1].toUpperCase();
    const respondedCaps = match[2].split(' ').filter(c => c);

    if (type === 'ACK') {
      for (const cap of respondedCaps) {
        // Handle -cap (disabled) vs cap (enabled)
        if (cap.startsWith('-')) {
          this.capState.enabled.delete(cap.substring(1));
        } else {
          this.capState.enabled.add(cap);
        }
      }
      return { ack: respondedCaps, nak: [] };
    } else {
      return { ack: [], nak: respondedCaps };
    }
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
   */
  async waitForRaw(pattern: string | RegExp, timeout = 5000): Promise<string> {
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
      for (const line of this.rawBuffer) {
        if (regex.test(line)) {
          clearTimeout(timer);
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
