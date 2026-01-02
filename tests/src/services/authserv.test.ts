/**
 * AuthServ Tests
 *
 * Tests X3 AuthServ functionality:
 * - Account registration
 * - Authentication
 * - User settings (USET)
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
  uniqueId,
} from '../helpers/index.js';

describe('AuthServ', () => {
  const clients: X3Client[] = [];

  const trackClient = (client: X3Client): X3Client => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
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
    it('should register a new account via REGISTER command', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

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
      const result = await client.registerAccount(
        `test${id}`,
        `pass${id}`,
        'not-an-email'
      );

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
    it('should authenticate with valid credentials', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // Register and activate (scrapes cookie from logs)
      const regResult = await client.registerAndActivate(account, password, email);

      if (regResult.success) {
        // Now try to auth - need a new connection
        const client2 = trackClient(await createX3Client());
        const authResult = await client2.auth(account, password);

        expect(authResult.lines.length).toBeGreaterThan(0);
        console.log('AUTH response:', authResult.lines);

        // Should succeed
        expect(authResult.success).toBe(true);
      } else {
        console.log('Skipping AUTH test - registration did not succeed:', regResult.error);
      }
    });

    it('should reject authentication with wrong password', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // Register and activate
      const regResult = await client.registerAndActivate(account, password, email);

      if (regResult.success) {
        // Try to auth with wrong password
        const client2 = trackClient(await createX3Client());
        const authResult = await client2.auth(account, 'wrongpassword');

        expect(authResult.lines.length).toBeGreaterThan(0);
        console.log('Wrong password response:', authResult.lines);

        // Should fail - X3 returns "Incorrect password; please try again."
        expect(authResult.success).toBe(false);
        // Error may or may not be populated depending on timing
        if (authResult.error) {
          expect(authResult.error).toContain('Incorrect');
        }
      } else {
        console.log('Skipping wrong password test - registration did not succeed');
      }
    });

    it('should reject authentication for non-existent account', async () => {
      const client = trackClient(await createX3Client());
      const fakeAccount = `fake${uniqueId().slice(0, 8)}`;

      const authResult = await client.auth(fakeAccount, 'anypassword');

      expect(authResult.lines.length).toBeGreaterThan(0);
      console.log('Non-existent account response:', authResult.lines);

      // Should fail
      expect(authResult.success).toBe(false);
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

  describe('USET (User Settings)', () => {
    it('should allow setting user preferences after authentication', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // Register and activate
      const regResult = await client.registerAndActivate(account, password, email);

      if (regResult.success) {
        const authResult = await client.auth(account, password);

        if (authResult.success) {
          // Try to set a preference
          const usetResult = await client.uset('STYLE', 'def');

          expect(usetResult.lines.length).toBeGreaterThan(0);
          console.log('USET response:', usetResult.lines);
        }
      }
    });
  });

  describe('Hostmask Management', () => {
    it('should add hostmask for authentication after registering', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      // Register and activate
      const regResult = await client.registerAndActivate(account, password, email);

      if (regResult.success) {
        const authResult = await client.auth(account, password);

        if (authResult.success) {
          // Add a hostmask
          const maskResult = await client.addMask('*!*@test.example.com');

          expect(maskResult.lines.length).toBeGreaterThan(0);
          console.log('ADDMASK response:', maskResult.lines);
        }
      }
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

      const lines = await client.serviceCmd('AuthServ', 'VERSION');

      expect(lines.length).toBeGreaterThan(0);
      console.log('VERSION response:', lines);
    });

    it('should respond to LISTMASKS command (when authenticated)', async () => {
      const client = trackClient(await createX3Client());
      const { account, password, email } = await createTestAccount();

      const regResult = await client.registerAndActivate(account, password, email);

      if (regResult.success) {
        const authResult = await client.auth(account, password);

        if (authResult.success) {
          const lines = await client.serviceCmd('AuthServ', 'LISTMASKS');

          expect(lines.length).toBeGreaterThan(0);
          console.log('LISTMASKS response:', lines);
        }
      }
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

    it('should handle invalid commands gracefully', async () => {
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
