/**
 * Cookie Observer - Watches #MrSnoopy for cookie broadcasts and relays them to test clients.
 *
 * X3 broadcasts "COOKIE <account> <cookie>" to #MrSnoopy when creating activation cookies.
 * This observer joins the snoop channel and caches cookies, making them available to test clients
 * via IRC messages, eliminating the need for Docker log scraping.
 *
 * Usage:
 *   // In test setup (once per test suite)
 *   const observer = await CookieObserver.create();
 *
 *   // In test client
 *   const cookie = await client.requestCookie('accountname', observer.nick);
 */

import { RawSocketClient, parseIRCMessage, type IRCMessage } from './ircv3-client';

const IRC_HOST = process.env.IRC_HOST || 'localhost';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667', 10);

/**
 * Cookie Observer that watches #MrSnoopy and relays cookies to test clients.
 */
export class CookieObserver extends RawSocketClient {
  private cookieCache = new Map<string, string>();
  private ready = false;
  private processedIndex = 0; // Track which messages we've already processed
  public readonly nick: string;

  private constructor(nick: string) {
    super();
    this.nick = nick;
  }

  /**
   * Create and initialize a CookieObserver.
   * Connects, authenticates as testadmin, and joins #MrSnoopy.
   */
  static async create(): Promise<CookieObserver> {
    // Generate unique nick per run - avoids collision with ghost nicks from previous runs
    const uniqueSuffix = Date.now().toString(36).slice(-5);
    const nick = `CB${uniqueSuffix}`;
    const observer = new CookieObserver(nick);
    await observer.initialize();
    return observer;
  }

  private async initialize(): Promise<void> {
    // Connect to IRC
    await this.connect(IRC_HOST, IRC_PORT);

    // Register with our unique nick - should never collide
    this.send(`NICK ${this.nick}`);
    this.send(`USER cookiebot 0 * :Cookie Observer Bot`);

    // Wait for welcome
    const response = await this.waitForLine(/^:\S+ (001|433)/, 5000);
    if (response.includes(' 433 ')) {
      // Extremely unlikely with timestamp-based nick, but handle it
      throw new Error(`Nick ${this.nick} unexpectedly in use`);
    }

    // Authenticate as testadmin (oper account)
    const adminUser = process.env.X3_ADMIN || 'testadmin';
    const adminPass = process.env.X3_ADMIN_PASS || 'testadmin123';
    this.send(`PRIVMSG AuthServ :AUTH ${adminUser} ${adminPass}`);

    // Wait for auth success - AuthServ responds with "I recognize you."
    await this.waitForLine(/I recognize you|authenticated|logged in/i, 5000);

    // Use SVSJOIN to join the invite-only snoop channel
    this.send(`PRIVMSG O3 :SVSJOIN ${this.nick} #MrSnoopy`);

    // Wait for join confirmation or SVSJOIN response
    try {
      await this.waitForLine(/JOIN.*#MrSnoopy|SVSJOIN/i, 5000);
    } catch {
      // May already be in channel or response format differs
    }

    // Set up message handler for cookie broadcasts and queries
    this.setupMessageHandler();

    this.ready = true;
    console.log(`[CookieObserver] Ready as ${this.nick}, watching #MrSnoopy`);
  }

  private setupMessageHandler(): void {
    // Periodic check for new messages only (avoid reprocessing)
    const checkInterval = setInterval(() => {
      if (!this.ready && this.cookieCache.size === 0) return;

      // allParsedLines returns IRCMessage[] directly
      const allMessages = this.allParsedLines;

      // Only process messages we haven't seen yet
      while (this.processedIndex < allMessages.length) {
        const msg = allMessages[this.processedIndex];
        this.processedIndex++;
        this.processMessage(msg, msg.raw);
      }
    }, 100);

    // Store interval for cleanup
    (this as any)._checkInterval = checkInterval;
  }

  private processMessage(msg: IRCMessage | undefined, raw: string): void {
    // Guard against undefined parsed messages
    if (!msg || !msg.command) return;

    // Watch for COOKIE broadcasts in #MrSnoopy
    // Format: :O3!service@host PRIVMSG #MrSnoopy :COOKIE accountname cookievalue
    if (msg.command === 'PRIVMSG') {
      const target = msg.params[0];
      const text = msg.params[1] || '';

      if (target.toLowerCase() === '#mrsnoopy') {
        const cookieMatch = text.match(/^COOKIE\s+(\S+)\s+(\S+)/i);
        if (cookieMatch) {
          const [, account, cookie] = cookieMatch;
          this.cookieCache.set(account.toLowerCase(), cookie);
          console.log(`[CookieObserver] Cached cookie for ${account}`);
        }
      }

      // Respond to GETCOOKIE queries from test clients
      // Format: PRIVMSG CookieBot :GETCOOKIE accountname
      if (target.toLowerCase() === this.nick.toLowerCase()) {
        const getCookieMatch = text.match(/^GETCOOKIE\s+(\S+)/i);
        if (getCookieMatch && msg.source?.nick) {
          const account = getCookieMatch[1].toLowerCase();
          const cookie = this.cookieCache.get(account);
          const requester = msg.source.nick;

          if (cookie) {
            this.send(`NOTICE ${requester} :COOKIE ${account} ${cookie}`);
            console.log(`[CookieObserver] Sent cookie for ${account} to ${requester}`);
          } else {
            this.send(`NOTICE ${requester} :NOTFOUND ${account}`);
          }
        }
      }
    }
  }

  /**
   * Get a cached cookie directly (for same-process access).
   */
  getCachedCookie(account: string): string | null {
    return this.cookieCache.get(account.toLowerCase()) || null;
  }

  /**
   * Check if the observer is ready.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Disconnect and cleanup.
   */
  async shutdown(): Promise<void> {
    if ((this as any)._checkInterval) {
      clearInterval((this as any)._checkInterval);
    }
    this.send('QUIT :Observer shutting down');
    await this.disconnect();
  }
}

/**
 * Singleton instance for test suites.
 * Also stored on globalThis for cross-module access without circular dependencies.
 */
let globalObserver: CookieObserver | null = null;

/**
 * Get or create the global CookieObserver instance.
 * Use this in test setup to ensure only one observer exists.
 */
export async function getGlobalCookieObserver(): Promise<CookieObserver> {
  if (!globalObserver || !globalObserver.isReady()) {
    globalObserver = await CookieObserver.create();
    // Store on globalThis for cross-module access
    (globalThis as any).__cookieObserver = globalObserver;
  }
  return globalObserver;
}

/**
 * Get the nick of the global observer if it exists.
 * Returns null if no observer is running.
 */
export function getGlobalObserverNick(): string | null {
  const observer = globalObserver || (globalThis as any).__cookieObserver;
  return observer?.nick || null;
}

/**
 * Shutdown the global observer.
 * Call this in test teardown.
 */
export async function shutdownGlobalCookieObserver(): Promise<void> {
  if (globalObserver) {
    await globalObserver.shutdown();
    globalObserver = null;
  }
}
