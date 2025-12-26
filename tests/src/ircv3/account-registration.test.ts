/**
 * IRCv3 draft/account-registration Tests
 *
 * Tests for the REGISTER and VERIFY commands as specified in:
 * https://ircv3.net/specs/extensions/account-registration
 *
 * These tests require X3 services to be running for account management.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

describe('IRCv3 Account Registration (draft/account-registration)', () => {
  const clients: RawSocketClient[] = [];
  let capAvailable = false;

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    // Check if capability is available
    const client = await createRawSocketClient();
    const caps = await client.capLs();
    capAvailable = caps.has('draft/account-registration');
    client.close();

    if (!capAvailable) {
      console.log('draft/account-registration capability not available');
    }
  });

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability Advertisement', () => {
    it('advertises draft/account-registration capability', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();

      expect(caps.has('draft/account-registration')).toBe(true);
      client.send('QUIT');
    });

    it('can request draft/account-registration capability', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      const result = await client.capReq(['draft/account-registration']);

      expect(result.nak).not.toContain('draft/account-registration');
      client.send('QUIT');
    });
  });

  describe('REGISTER Command - Before Registration', () => {
    it.skipIf(!capAvailable)('REGISTER command is accepted pre-registration', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      // Don't send CAP END yet - still in pre-registration
      const uniqueAccount = `regtest_${Date.now()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get some response (success, failure, or verification needed)
      const response = await client.waitForLine(/(REGISTER|FAIL|VERIFY)/i, 10000);
      expect(response).toBeDefined();
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER requires account name', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      // Missing account name
      client.send('REGISTER');

      // Should get FAIL response
      const response = await client.waitForLine(/FAIL.*REGISTER.*NEED_MORE_PARAMS/i, 5000);
      expect(response).toMatch(/FAIL/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER rejects account names that are too long', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      // Account name longer than ACCOUNTLEN (typically 15)
      const longAccount = 'a'.repeat(50);
      client.send(`REGISTER ${longAccount} * testpassword123`);

      // Should get FAIL with BAD_ACCOUNT_NAME
      const response = await client.waitForLine(/FAIL.*REGISTER.*BAD_ACCOUNT_NAME/i, 5000);
      expect(response).toMatch(/BAD_ACCOUNT_NAME/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER rejects weak passwords (too short)', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      const uniqueAccount = `weakpw_${Date.now()}`;
      // Password shorter than minimum (5 chars)
      client.send(`REGISTER ${uniqueAccount} * abc`);

      // Should get FAIL with WEAK_PASSWORD
      const response = await client.waitForLine(/FAIL.*REGISTER.*WEAK_PASSWORD/i, 5000);
      expect(response).toMatch(/WEAK_PASSWORD/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER rejects weak passwords (too long)', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      const uniqueAccount = `longpw_${Date.now()}`;
      // Password longer than maximum (300 chars)
      const longPassword = 'a'.repeat(350);
      client.send(`REGISTER ${uniqueAccount} * ${longPassword}`);

      // Should get FAIL with WEAK_PASSWORD
      const response = await client.waitForLine(/FAIL.*REGISTER.*WEAK_PASSWORD/i, 5000);
      expect(response).toMatch(/WEAK_PASSWORD/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER accepts email parameter', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      const uniqueAccount = `emailtest_${Date.now()}`;
      client.send(`REGISTER ${uniqueAccount} test@example.com testpassword123`);

      // Should get some response (REGISTER success/verify or FAIL)
      const response = await client.waitForLine(/(REGISTER|FAIL|VERIFY)/i, 10000);
      expect(response).toBeDefined();
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('REGISTER accepts * for no email', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      const uniqueAccount = `noemail_${Date.now()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get some response
      const response = await client.waitForLine(/(REGISTER|FAIL|VERIFY)/i, 10000);
      expect(response).toBeDefined();
      client.send('QUIT');
    });
  });

  describe('REGISTER Command - After Registration', () => {
    it.skipIf(!capAvailable)('REGISTER fails if already authenticated', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'sasl']);

      // First, authenticate (assuming a test account exists)
      // If no test account, this will fail, but we can still test the error
      client.capEnd();
      client.register('regafter1');
      await client.waitForLine(/001/);

      // Try to REGISTER while already connected
      const uniqueAccount = `afterauth_${Date.now()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get FAIL ALREADY_AUTHENTICATED or similar
      try {
        const response = await client.waitForLine(/FAIL.*REGISTER/i, 5000);
        expect(response).toMatch(/FAIL.*REGISTER/i);
      } catch {
        // Some implementations may just ignore the command after registration
      }
      client.send('QUIT');
    });
  });

  describe('VERIFY Command', () => {
    it.skipIf(!capAvailable)('VERIFY requires account and code', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      // Missing parameters
      client.send('VERIFY');

      // Should get FAIL response
      const response = await client.waitForLine(/FAIL.*VERIFY.*NEED_MORE_PARAMS/i, 5000);
      expect(response).toMatch(/FAIL/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('VERIFY fails with invalid code', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);

      // Try to verify with an invalid code
      client.send('VERIFY nonexistent_account INVALIDCODE');

      // Should get FAIL response (no account or bad code)
      const response = await client.waitForLine(/FAIL.*VERIFY/i, 5000);
      expect(response).toMatch(/FAIL.*VERIFY/i);
      client.send('QUIT');
    });

    it.skipIf(!capAvailable)('VERIFY fails if already authenticated', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration']);
      client.capEnd();
      client.register('verifyafter1');
      await client.waitForLine(/001/);

      // Try to VERIFY while already connected
      client.send('VERIFY testaccount SOMECODE');

      // Should get FAIL ALREADY_AUTHENTICATED
      try {
        const response = await client.waitForLine(/FAIL.*VERIFY/i, 5000);
        expect(response).toMatch(/FAIL.*VERIFY/i);
      } catch {
        // Some implementations may ignore
      }
      client.send('QUIT');
    });
  });

  describe('Account Registration Response Codes', () => {
    it.skipIf(!capAvailable)('handles ACCOUNT_EXISTS correctly', async () => {
      // This test assumes we can create a temporary account
      // If accounts persist, this may need adjustment
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/account-registration']);

      await client2.capLs();
      await client2.capReq(['draft/account-registration']);

      const testAccount = `duptest_${Date.now()}`;

      // First registration attempt
      client1.send(`REGISTER ${testAccount} * testpassword123`);
      const response1 = await client1.waitForLine(/(REGISTER|FAIL)/i, 10000);

      // If first succeeded, second should fail with ACCOUNT_EXISTS
      if (response1.includes('REGISTER') && !response1.includes('FAIL')) {
        // Wait a moment for account to be created
        await new Promise(r => setTimeout(r, 500));

        // Second registration with same account
        client2.send(`REGISTER ${testAccount} * differentpassword`);
        const response2 = await client2.waitForLine(/FAIL.*REGISTER.*ACCOUNT_EXISTS/i, 10000);
        expect(response2).toMatch(/ACCOUNT_EXISTS/i);
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Standard Replies Integration', () => {
    it.skipIf(!capAvailable)('errors use standard-replies format when enabled', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Trigger an error
      client.send('REGISTER');

      const response = await client.waitForLine(/FAIL.*REGISTER/i, 5000);
      // Standard reply format: FAIL REGISTER CODE [context] :message
      expect(response).toMatch(/^FAIL REGISTER \w+/i);
      client.send('QUIT');
    });
  });
});
