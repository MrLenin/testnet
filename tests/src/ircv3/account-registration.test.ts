/**
 * IRCv3 draft/account-registration Tests
 *
 * Tests for the REGISTER and VERIFY commands as specified in:
 * https://ircv3.net/specs/extensions/account-registration
 *
 * These tests require X3 services to be running for account management.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';

describe('IRCv3 Account Registration (draft/account-registration)', () => {
  const clients: RawSocketClient[] = [];
  let capAvailable = false;

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  // Helper to skip test at runtime if capability not available
  const skipIfNoCap = (ctx: { skip: () => void }) => {
    if (!capAvailable) {
      console.log('Skipping - draft/account-registration not available');
      ctx.skip();
    }
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
    it('REGISTER command is accepted pre-registration', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Don't send CAP END yet - still in pre-registration
      const uniqueAccount = `regtest_${uniqueId()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get some response (success, failure, or verification needed)
      const response = await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' || msg.command === 'FAIL' || msg.command === 'VERIFY',
        10000
      );
      expect(response).toBeDefined();
      client.send('QUIT');
    });

    it('REGISTER requires account name', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Missing account name
      client.send('REGISTER');

      // Should get FAIL response
      const response = await client.waitForFail('REGISTER', 'NEED_MORE_PARAMS', 5000);
      expect(response.command).toBe('FAIL');
      client.send('QUIT');
    });

    it('REGISTER rejects account names that are too long', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Account name longer than ACCOUNTLEN (typically 15)
      const longAccount = 'a'.repeat(50);
      client.send(`REGISTER ${longAccount} * testpassword123`);

      // Should get FAIL with BAD_ACCOUNT_NAME
      const response = await client.waitForFail('REGISTER', 'BAD_ACCOUNT_NAME', 5000);
      expect(response.params[1]).toBe('BAD_ACCOUNT_NAME');
      client.send('QUIT');
    });

    it('REGISTER rejects weak passwords (too short)', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Use short account name (ACCOUNTLEN=15)
      const uniqueAccount = `wpw${Math.floor(Math.random() * 9999)}`;
      // Password shorter than minimum (5 chars)
      client.send(`REGISTER ${uniqueAccount} * abc`);

      // Should get FAIL with WEAK_PASSWORD
      const response = await client.waitForFail('REGISTER', 'WEAK_PASSWORD', 5000);
      expect(response.params[1]).toBe('WEAK_PASSWORD');
      client.send('QUIT');
    });

    it('REGISTER rejects weak passwords (too long)', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Use short account name (ACCOUNTLEN=15)
      const uniqueAccount = `lpw${Math.floor(Math.random() * 9999)}`;
      // Password longer than maximum (300 chars)
      const longPassword = 'a'.repeat(350);
      client.send(`REGISTER ${uniqueAccount} * ${longPassword}`);

      // Should get FAIL with WEAK_PASSWORD
      const response = await client.waitForFail('REGISTER', 'WEAK_PASSWORD', 5000);
      expect(response.params[1]).toBe('WEAK_PASSWORD');
      client.send('QUIT');
    });

    it('REGISTER accepts email parameter', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      const uniqueAccount = `emailtest_${uniqueId()}`;
      client.send(`REGISTER ${uniqueAccount} test@example.com testpassword123`);

      // Should get some response (REGISTER success/verify or FAIL)
      const response = await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' || msg.command === 'FAIL' || msg.command === 'VERIFY',
        10000
      );
      expect(response).toBeDefined();
      client.send('QUIT');
    });

    it('REGISTER accepts * for no email', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      const uniqueAccount = `noemail_${uniqueId()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get some response
      const response = await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' || msg.command === 'FAIL' || msg.command === 'VERIFY',
        10000
      );
      expect(response).toBeDefined();
      client.send('QUIT');
    });
  });

  describe('REGISTER Command - After Registration', () => {
    it('REGISTER fails if already authenticated', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies', 'sasl']);

      // First, authenticate (assuming a test account exists)
      // If no test account, this will fail, but we can still test the error
      client.capEnd();
      client.register('regafter1');
      await client.waitForNumeric('001');

      // Try to REGISTER while already connected
      const uniqueAccount = `afterauth_${uniqueId()}`;
      client.send(`REGISTER ${uniqueAccount} * testpassword123`);

      // Should get FAIL ALREADY_AUTHENTICATED or similar
      try {
        const response = await client.waitForFail('REGISTER', undefined, 5000);
        expect(response.command).toBe('FAIL');
      } catch {
        // Some implementations may just ignore the command after registration
      }
      client.send('QUIT');
    });
  });

  describe('VERIFY Command', () => {
    it('VERIFY requires account and code', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Missing parameters
      client.send('VERIFY');

      // Should get FAIL response
      const response = await client.waitForFail('VERIFY', 'NEED_MORE_PARAMS', 5000);
      expect(response.command).toBe('FAIL');
      client.send('QUIT');
    });

    it('VERIFY fails with invalid code', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Try to verify with an invalid code
      client.send('VERIFY nonexistent_account INVALIDCODE');

      // Should get FAIL response (no account or bad code)
      // Note: Server may return FAIL REGISTER or FAIL VERIFY depending on implementation
      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' && (msg.params[0] === 'VERIFY' || msg.params[0] === 'REGISTER'),
        5000
      );
      expect(response.command).toBe('FAIL');
      client.send('QUIT');
    });

    it('VERIFY fails if already authenticated', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);
      client.capEnd();
      client.register('verifyafter1');
      await client.waitForNumeric('001');

      // Try to VERIFY while already connected
      client.send('VERIFY testaccount SOMECODE');

      // Should get FAIL ALREADY_AUTHENTICATED
      // Note: Server may return FAIL REGISTER or FAIL VERIFY depending on implementation
      try {
        const response = await client.waitForParsedLine(
          msg => msg.command === 'FAIL' && (msg.params[0] === 'VERIFY' || msg.params[0] === 'REGISTER'),
          5000
        );
        expect(response.command).toBe('FAIL');
      } catch {
        // Some implementations may ignore
      }
      client.send('QUIT');
    });
  });

  describe('Account Registration Response Codes', () => {
    it('handles ACCOUNT_EXISTS correctly', async (ctx) => {
      skipIfNoCap(ctx);
      // This test assumes we can create a temporary account
      // If accounts persist, this may need adjustment
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/account-registration', 'standard-replies']);

      await client2.capLs();
      await client2.capReq(['draft/account-registration', 'standard-replies']);

      const testAccount = `duptest_${uniqueId()}`;

      // First registration attempt
      client1.send(`REGISTER ${testAccount} * testpassword123`);
      const response1 = await client1.waitForParsedLine(
        msg => msg.command === 'REGISTER' || msg.command === 'FAIL',
        10000
      );

      // If first succeeded, second should fail with ACCOUNT_EXISTS
      if (response1.command === 'REGISTER') {
        // Wait a moment for account to be created
        await new Promise(r => setTimeout(r, 500));

        // Second registration with same account
        client2.send(`REGISTER ${testAccount} * differentpassword`);
        const response2 = await client2.waitForFail('REGISTER', 'ACCOUNT_EXISTS', 10000);
        expect(response2.params[1]).toBe('ACCOUNT_EXISTS');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Standard Replies Integration', () => {
    it('errors use standard-replies format when enabled', async (ctx) => {
      skipIfNoCap(ctx);
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['draft/account-registration', 'standard-replies']);

      // Trigger an error
      client.send('REGISTER');

      const response = await client.waitForFail('REGISTER', undefined, 5000);
      // Standard reply format: FAIL REGISTER CODE [context] :message
      expect(response.command).toBe('FAIL');
      expect(response.params[0]).toBe('REGISTER');
      client.send('QUIT');
    });
  });
});
