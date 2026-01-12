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
}

class AccountPool {
  private static instance: AccountPool | null = null;
  private accounts: Map<string, PoolAccount> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Pool configuration
  private readonly POOL_SIZE = 30;
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
      });
    }

    // Check which accounts already exist
    const existingAccounts = await this.checkExistingAccounts();
    console.log(`[AccountPool] Found ${existingAccounts.size} existing accounts`);

    // Create missing accounts
    const missing = Array.from(this.accounts.values())
      .filter(a => !existingAccounts.has(a.account));

    if (missing.length > 0) {
      console.log(`[AccountPool] Creating ${missing.length} missing accounts...`);
      await this.createAccounts(missing);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[AccountPool] Initialized in ${elapsed}ms`);
  }

  /**
   * Check which pool accounts already exist in X3.
   * Uses AUTH attempt - "Incorrect password" or success means account exists.
   */
  private async checkExistingAccounts(): Promise<Set<string>> {
    const existing = new Set<string>();
    let client: X3Client | null = null;

    try {
      client = await createX3Client('poolchk');

      for (const [account, spec] of this.accounts) {
        const result = await client.auth(account, spec.password);

        // Account exists if we get success or "Incorrect password"
        // (password mismatch means account exists but different password)
        if (result.success || result.error?.includes('Incorrect')) {
          existing.add(account);
        }
        // "not registered" means account doesn't exist - nothing to do

        // Small delay to avoid flooding
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      if (client) {
        client.send('QUIT');
        client.close();
      }
    }

    return existing;
  }

  /**
   * Create missing pool accounts.
   * Creates accounts sequentially (Keycloak doesn't handle parallel well).
   */
  private async createAccounts(accounts: PoolAccount[]): Promise<void> {
    for (const spec of accounts) {
      let client: X3Client | null = null;
      try {
        client = await createX3Client(`reg${spec.account.slice(-2)}`);

        const result = await client.registerAndActivate(
          spec.account, spec.password, spec.email
        );

        if (result.success) {
          console.log(`[AccountPool] Created ${spec.account}`);
        } else {
          console.warn(`[AccountPool] Failed to create ${spec.account}: ${result.error}`);
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
   * Returns null if no accounts available (caller should create fresh).
   */
  checkout(): PoolAccount | null {
    for (const spec of this.accounts.values()) {
      if (!spec.inUse) {
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
  getStats(): { total: number; available: number; inUse: number } {
    let available = 0;
    let inUse = 0;
    for (const spec of this.accounts.values()) {
      if (spec.inUse) inUse++;
      else available++;
    }
    return { total: this.accounts.size, available, inUse };
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
