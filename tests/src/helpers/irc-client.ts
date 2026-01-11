import { Client } from 'irc-framework';

export interface IRCConfig {
  host: string;
  port: number;
  nick: string;
  username?: string;
  gecos?: string;
  tls?: boolean;
}

export interface MessageEvent {
  nick: string;
  ident: string;
  hostname: string;
  target: string;
  message: string;
  tags: Record<string, string>;
  reply: (message: string) => void;
}

export interface JoinEvent {
  nick: string;
  ident: string;
  hostname: string;
  channel: string;
  account?: string;
}

export interface RawEvent {
  from_server: boolean;
  line: string;
  tags: Record<string, string>;
}

/**
 * Wrapper around irc-framework Client with async helpers for testing.
 * Inspired by ZNC's ReadUntil pattern.
 *
 * @deprecated Use RawSocketClient or IRCv3TestClient instead.
 * TestIRCClient uses irc-framework's event-based model which has different
 * timing characteristics than the consumption-based model in RawSocketClient.
 * For reliable protocol testing, prefer RawSocketClient.
 */
export class TestIRCClient {
  private client: Client;
  private rawBuffer: string[] = [];
  private connected = false;

  constructor() {
    this.client = new Client();

    // Buffer all raw messages for debugging
    this.client.on('raw', (event: RawEvent) => {
      this.rawBuffer.push(event.line);
    });
  }

  /**
   * Connect to an IRC server and wait for registration.
   */
  async connect(config: IRCConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${config.host}:${config.port}`));
      }, 10000);

      this.client.connect({
        host: config.host,
        port: config.port,
        nick: config.nick,
        username: config.username ?? config.nick,
        gecos: config.gecos ?? 'Test Client',
        tls: config.tls ?? false,
        auto_reconnect: false,
      });

      this.client.once('registered', () => {
        clearTimeout(timeout);
        this.connected = true;
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
   * Wait for a specific event to occur.
   */
  async waitForEvent<T = unknown>(
    event: string,
    timeout = 5000
  ): Promise<T> {
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
   * Wait until a raw message matching the pattern is received.
   * Similar to ZNC's ReadUntil pattern.
   */
  async waitForRaw(
    pattern: string | RegExp,
    timeout = 5000
  ): Promise<string> {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for raw pattern: ${pattern}\nReceived:\n${this.rawBuffer.slice(-20).join('\n')}`
          )
        );
      }, timeout);

      // Check buffer first
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
   * Send a raw IRC command.
   */
  raw(command: string): void {
    this.client.raw(command);
  }

  /**
   * Join a channel.
   */
  join(channel: string): void {
    this.client.join(channel);
  }

  /**
   * Send a message to a channel or user.
   */
  say(target: string, message: string): void {
    this.client.say(target, message);
  }

  /**
   * Send a NOTICE to a channel or user.
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
   * Quit and disconnect.
   */
  quit(message?: string): void {
    this.client.quit(message);
  }

  /**
   * Get the underlying irc-framework client for advanced operations.
   */
  get raw_client(): Client {
    return this.client;
  }

  /**
   * Get all raw messages received (for debugging).
   */
  get rawMessages(): string[] {
    return [...this.rawBuffer];
  }

  /**
   * Clear the raw message buffer.
   */
  clearRawBuffer(): void {
    this.rawBuffer = [];
  }
}

/**
 * Create a connected test client.
 */
export async function createTestClient(
  config: Partial<IRCConfig> & { nick: string }
): Promise<TestIRCClient> {
  const client = new TestIRCClient();
  await client.connect({
    host: config.host ?? 'nefarious',
    port: config.port ?? 6667,
    nick: config.nick,
    username: config.username,
    gecos: config.gecos,
    tls: config.tls,
  });
  return client;
}
