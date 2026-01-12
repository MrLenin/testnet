/**
 * Account Pool Manager
 *
 * Pre-creates and manages a pool of test accounts for fast checkout.
 * Eliminates the 15-20s per-account registration overhead by reusing
 * pre-registered accounts across test runs.
 *
 * Pool accounts persist in X3/Keycloak across test runs. On initialization,
 * the pool checks which accounts exist and only creates missing ones.
 *
 * Usage:
 *   // Get an account (pool or fresh fallback)
 *   const { account, password, fromPool } = await getTestAccount();
 *
 *   // Return to pool when done
 *   releaseTestAccount(account);
 *
 *   // Force fresh account (for duplicate registration tests)
 *   const fresh = await getTestAccount({ requireFresh: true });
 */

import { createX3Client, type X3Client } from './x3-client.js';

export interface PoolAccount {
  account: string;
  password: string;
  email: string;
  inUse: boolean;
  verified: boolean;  // True if AUTH succeeded with expected password
}

class AccountPool {
  private static instance: AccountPool | null = null;
  private accounts: Map<string, PoolAccount> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Pool configuration
  private readonly POOL_SIZE = 10;
  private readonly POOL_PREFIX = 'pool';
  private readonly POOL_PASSWORD_BASE = 'poolpass';
  private readonly POOL_EMAIL_DOMAIN = 'pool.test';

  private constructor() {}

  static getInstance(): AccountPool {
    if (!AccountPool.instance) {
      AccountPool.instance = new AccountPool();
    }
    return AccountPool.instance;
  }

  /**
   * Initialize the account pool.
   * Checks which accounts exist and creates missing ones.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize();
    await this.initPromise;
    this.initialized = true;
  }

  private async _doInitialize(): Promise<void> {
    console.log(`[AccountPool] Initializing pool of ${this.POOL_SIZE} accounts...`);
    const startTime = Date.now();

    // Generate all account specs
    for (let i = 0; i < this.POOL_SIZE; i++) {
      const num = i.toString().padStart(2, '0');
      const account = `${this.POOL_PREFIX}${num}`;
      this.accounts.set(account, {
        account,
        password: `${this.POOL_PASSWORD_BASE}${num}`,
        email: `${account}@${this.POOL_EMAIL_DOMAIN}`,
        inUse: false,
        verified: false,
      });
    }

    // Check which accounts already exist and verify passwords
    const { working, broken, missing } = await this.checkExistingAccounts();
    console.log(`[AccountPool] Found ${working.size} working, ${broken.size} broken, ${missing.size} missing accounts`);

    // Mark working accounts as verified
    for (const account of working) {
      const spec = this.accounts.get(account);
      if (spec) spec.verified = true;
    }

    // Create missing accounts
    const missingSpecs = Array.from(this.accounts.values())
      .filter(a => missing.has(a.account));

    if (missingSpecs.length > 0) {
      console.log(`[AccountPool] Creating ${missingSpecs.length} missing accounts...`);
      await this.createAccounts(missingSpecs);
    }

    // Handle broken accounts (exist but wrong password) - skip them for now
    // They'll be excluded from checkout since verified=false
    if (broken.size > 0) {
      console.log(`[AccountPool] ${broken.size} accounts have wrong passwords and will be skipped`);
      console.log(`[AccountPool] To fix, run: npm run cleanup -- --include-pool`);
    }

    const elapsed = Date.now() - startTime;
    const stats = this.getStats();
    console.log(`[AccountPool] Initialized in ${elapsed}ms - ${stats.available} accounts available for tests`);
  }

  /**
   * Check which pool accounts already exist in X3 and verify passwords.
   * Returns three sets:
   * - working: AUTH succeeds with expected password
   * - broken: Account exists but password doesn't match
   * - missing: Account doesn't exist
   */
  private async checkExistingAccounts(): Promise<{
    working: Set<string>;
    broken: Set<string>;
    missing: Set<string>;
  }> {
    const working = new Set<string>();
    const broken = new Set<string>();
    const missing = new Set<string>();
    let client: X3Client | null = null;

    try {
      client = await createX3Client('poolchk');

      for (const [account, spec] of this.accounts) {
        // Use short initial timeout (1s) - if X3 is responsive, this is plenty
        let result = await client.auth(account, spec.password, 1000);

        // If timeout, retry once with slightly longer timeout
        if (!result.error && result.lines.length === 0) {
          result = await client.auth(account, spec.password, 3000);
        }

        if (result.success) {
          // AUTH succeeded - account exists with correct password
          working.add(account);
        } else if (result.error?.toLowerCase().includes('not registered') ||
                   result.error?.toLowerCase().includes('no such account')) {
          // Account genuinely doesn't exist
          missing.add(account);
        } else if (!result.error || result.lines.length === 0) {
          // Still no response after retry - mark broken (don't try to re-create)
          console.warn(`[AccountPool] AUTH still timing out for ${account}, marking broken`);
          broken.add(account);
        } else {
          // Account exists but has some issue (wrong password, not activated, suspended, etc.)
          // Don't try to re-register these
          broken.add(account);
        }

        // Minimal delay between checks
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      if (client) {
        client.send('QUIT');
        client.close();
      }
    }

    return { working, broken, missing };
  }

  /**
   * Create missing pool accounts.
   * Uses fire-and-forget registration with cookie appearance as success signal.
   * This avoids depending on serviceCmd timeouts when X3 is under load.
   */
  private async createAccounts(accounts: PoolAccount[]): Promise<void> {
    for (const spec of accounts) {
      let client: X3Client | null = null;
      try {
        client = await createX3Client(`reg${spec.account.slice(-2)}`);

        // Fire-and-forget registration - don't wait for NOTICE response
        await client.registerAccountFireAndForget(spec.account, spec.password, spec.email);

        // Wait for cookie to appear (proves registration succeeded)
        // Use longer timeout (30s) to handle Keycloak backlog
        const cookie = await client.getCookie(spec.account, undefined, 30000);

        if (!cookie) {
          console.warn(`[AccountPool] No cookie received for ${spec.account} - registration may have failed`);
          continue;
        }

        // Activate with the cookie
        const activateResult = await client.activateAccount(spec.account, cookie, spec.password);

        if (activateResult.success) {
          console.log(`[AccountPool] Created ${spec.account}`);
          // Mark as verified in the pool
          const poolSpec = this.accounts.get(spec.account);
          if (poolSpec) poolSpec.verified = true;
        } else {
          console.warn(`[AccountPool] Failed to activate ${spec.account}: ${activateResult.error}`);
        }
      } catch (error) {
        console.warn(`[AccountPool] Error creating ${spec.account}:`, error);
      } finally {
        if (client) {
          client.send('QUIT');
          client.close();
        }
      }
    }
  }

  /**
   * Checkout an available account from the pool.
   * Only returns verified accounts (AUTH succeeded with expected password).
   * Returns null if no accounts available (caller should create fresh).
   */
  checkout(): PoolAccount | null {
    for (const spec of this.accounts.values()) {
      if (!spec.inUse && spec.verified) {
        spec.inUse = true;
        return { ...spec }; // Return copy to prevent modification
      }
    }
    return null;
  }

  /**
   * Return an account to the pool.
   */
  checkin(account: string): void {
    const spec = this.accounts.get(account);
    if (spec) {
      spec.inUse = false;
    }
  }

  /**
   * Get pool statistics.
   */
  getStats(): { total: number; verified: number; available: number; inUse: number; broken: number } {
    let verified = 0;
    let available = 0;
    let inUse = 0;
    for (const spec of this.accounts.values()) {
      if (spec.verified) {
        verified++;
        if (spec.inUse) inUse++;
        else available++;
      }
    }
    return {
      total: this.accounts.size,
      verified,
      available,
      inUse,
      broken: this.accounts.size - verified
    };
  }

  /**
   * Check if pool is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset pool state (for testing).
   */
  reset(): void {
    this.accounts.clear();
    this.initialized = false;
    this.initPromise = null;
  }
}

// Singleton instance
export const accountPool = AccountPool.getInstance();

// Convenience exports
export async function initializeAccountPool(): Promise<void> {
  return accountPool.initialize();
}

export function checkoutPoolAccount(): PoolAccount | null {
  return accountPool.checkout();
}

export function checkinPoolAccount(account: string): void {
  accountPool.checkin(account);
}

export function getPoolStats() {
  return accountPool.getStats();
}

export function isPoolInitialized(): boolean {
  return accountPool.isInitialized();
}
