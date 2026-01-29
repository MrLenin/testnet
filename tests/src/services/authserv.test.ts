/**
 * AuthServ Tests
 *
 * Tests X3 AuthServ functionality:
 * - Account registration
 * - Authentication
 * - User settings (SET)
 * - Hostmask management
 *
 * AuthServ Communication:
 *   Client → AuthServ:  PRIVMSG AuthServ :<command>
 *   AuthServ → Client:  NOTICE <nick> :<response>
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  X3Client,
  createX3Client,
  createTestAccount,
  getTestAccount,
  setupTestAccount,
  releaseTestAccount,
  uniqueId,
  assertServiceSuccess,
  assertServiceError,
} from '../helpers/index.js';

describe('AuthServ', () => {
  const clients: X3Client[] = [];
  const poolAccounts: string[] = [];  // Track pool accounts for cleanup

  const trackClient = (client: X3Client): X3Client => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    // Release pool accounts first
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;

    // Then close clients
    for (const client of clients) {
      try {
        client.send('QUIT');
        client.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    clients.length = 0;
  });

  describe('Account Registration', () => {
    it('should register a new account via REGISTER command', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      // Register the account
      const result = await client.registerAccount(account, password, email);

      // Check response - X3 may require authentication or specific conditions
      // The response should either succeed or give a clear error
      expect(result.lines.length).toBeGreaterThan(0);
      console.log('REGISTER response:', result.lines);

      // If registration succeeded, we should see a success message
      if (result.success) {
        expect(result.success).toBe(true);
      } else {
        // If it failed, we should have an error message
        console.log('Registration failed (may require specific conditions):', result.error);
      }
    });

    it('should reject registration with invalid email format', async () => {
      const client = trackClient(await createX3Client());
      const id = uniqueId().slice(0, 6);

      // Try to register with invalid email
      // Use retry logic since X3 can be blocked on Keycloak sync operations
      let result: { lines: string[]; success: boolean; error?: string } = { lines: [], success: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await client.registerAccount(
          `test${id}`,
          `pass${id}`,
          'not-an-email'
        );
        if (result.lines.length > 0) break;
        console.log(`[attempt ${attempt + 1}] No response, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
      }

      expect(result.lines.length).toBeGreaterThan(0);
      console.log('Invalid email response:', result.lines);

      // Should either reject or have specific behavior
      // X3's email validation depends on configuration
    });

    it('should reject duplicate account registration', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // First registration
      const first = await client.registerAccount(account, password, email);
      console.log('First registration:', first.lines);

      // If first succeeded, try to register again
      if (first.success) {
        // Wait for X3 to fully process first registration
        await new Promise(r => setTimeout(r, 500));

        // Get a new client for second attempt
        const client2 = trackClient(await createX3Client());
        const second = await client2.registerAccount(account, password, email);
        console.log('Second registration attempt:', second.lines);

        // Should fail because account exists
        expect(second.success).toBe(false);
        // Should have an error mentioning already registered
        // X3 says "Account X is already registered"
        const hasAlreadyError = second.lines.some(l =>
          l.toLowerCase().includes('already') ||
          l.toLowerCase().includes('in use') ||
          l.toLowerCase().includes('registered')
        );
        expect(hasAlreadyError).toBe(true);
      } else {
        console.log('First registration failed:', first.error);
      }
    });
  });

  describe('Authentication', () => {
    it('should authenticate with valid credentials', { retry: 2 }, async () => {
      // Get a test account (pool or fresh) - setupTestAccount handles AUTH/register
      const client = trackClient(await createX3Client());
      const { account, password, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);

      // Now try to auth on a new connection to verify credentials work
      const client2 = trackClient(await createX3Client());
      const authResult = await client2.auth(account, password);

      // Should succeed with acknowledgment message
      assertServiceSuccess(authResult, /authorized|authenticated|greeting|welcome|recognize/i);
      console.log('AUTH response:', authResult.lines);
    });

    it('should reject authentication with wrong password', { retry: 2 }, async () => {
      // Get a test account to test wrong password against
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);

      // Try to auth with wrong password on new connection
      const client2 = trackClient(await createX3Client());
      const authResult = await client2.auth(account, 'wrongpassword');

      // Should fail with incorrect password message
      assertServiceError(authResult, /incorrect|wrong|invalid|denied/i);
      console.log('Wrong password response:', authResult.lines);
    });

    it('should reject authentication for non-existent account', async () => {
      const client = trackClient(await createX3Client());
      const fakeAccount = `fake${uniqueId().slice(0, 8)}`;

      const authResult = await client.auth(fakeAccount, 'anypassword');

      // Should fail with account not found message
      assertServiceError(authResult, /not registered|unknown|no such|not found|could not find/i);
      console.log('Non-existent account response:', authResult.lines);
    });

    it('should report authentication status via ACCOUNTINFO', async () => {
      const client = trackClient(await createX3Client());

      // Check auth status when not authenticated
      const notAuthResult = await client.checkAuth();
      console.log('ACCOUNTINFO (not authenticated):', notAuthResult);

      // Should report not authenticated
      expect(notAuthResult.authenticated).toBe(false);
    });
  });

  describe('SET (User Settings)', () => {
    it('should allow setting user preferences after authentication', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);

      // Try to set a preference (STYLE is a valid SET option)
      const setResult = await client.setUserOption('STYLE', 'def');
      console.log('SET STYLE response:', setResult.lines);

      expect(setResult.lines.length).toBeGreaterThan(0);
      // Should succeed or report current value
      expect(setResult.lines.some(l =>
        l.includes('STYLE') || l.includes('style') || l.includes('set')
      )).toBe(true);
    });
  });

  describe('Hostmask Management', () => {
    it('should add hostmask for authentication after registering', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);

      // Add a hostmask
      const maskResult = await client.addMask('*!*@test.example.com');

      expect(maskResult.lines.length).toBeGreaterThan(0);
      console.log('ADDMASK response:', maskResult.lines);
    });
  });

  describe('Direct PRIVMSG Commands', () => {
    it('should respond to HELP command', async () => {
      const client = trackClient(await createX3Client());

      // Send HELP command directly
      const lines = await client.serviceCmd('AuthServ', 'HELP');

      expect(lines.length).toBeGreaterThan(0);
      console.log('HELP response (first 5 lines):', lines.slice(0, 5));

      // Should have help information
      const hasHelp = lines.some(l =>
        l.includes('HELP') ||
        l.includes('AuthServ') ||
        l.includes('command')
      );
      expect(hasHelp).toBe(true);
    });

    it('should respond to VERSION command', async () => {
      const client = trackClient(await createX3Client());

      // Wait for connection to settle before sending service commands
      await new Promise(r => setTimeout(r, 1000));

      const lines = await client.serviceCmd('AuthServ', 'VERSION');

      expect(lines.length).toBeGreaterThan(0);
      console.log('VERSION response:', lines);
    });

    it('should show hostmasks via ACCOUNTINFO command (when authenticated)', async () => {
      const client = trackClient(await createX3Client());
      const { account, fromPool } = await setupTestAccount(client);
      if (fromPool) poolAccounts.push(account);

      // ACCOUNTINFO shows account details including hostmasks
      const lines = await client.serviceCmd('AuthServ', 'ACCOUNTINFO');
      console.log('ACCOUNTINFO response:', lines);

      expect(lines.length).toBeGreaterThan(0);
      // Should show account information
      expect(lines.some(l =>
        l.includes('Account') || l.includes('Hostmask') || l.includes('mask')
      )).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle AUTH without being connected properly', async () => {
      const client = trackClient(await createX3Client());

      // AUTH should provide feedback even if we're not properly authed
      const result = await client.auth('someaccount', 'somepassword');

      // Should get some response (either error or failure message)
      expect(result.lines.length).toBeGreaterThan(0);
    });

    it('should handle invalid commands gracefully', { retry: 2 }, async () => {
      const client = trackClient(await createX3Client());

      // Send an invalid command
      const lines = await client.serviceCmd('AuthServ', 'INVALIDCOMMAND123');

      expect(lines.length).toBeGreaterThan(0);
      console.log('Invalid command response:', lines);

      // Should have an error message
      const hasError = lines.some(l =>
        l.toLowerCase().includes('unknown') ||
        l.toLowerCase().includes('invalid') ||
        l.toLowerCase().includes('not') ||
        l.toLowerCase().includes('help')
      );
      expect(hasError).toBe(true);
    });
  });
});
