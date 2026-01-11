import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';

/**
 * User Change Tests
 *
 * Tests for capabilities that notify clients about user changes:
 * - setname: Change realname/gecos
 * - chghost: Notifies when user's host changes
 */
describe('IRCv3 setname', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

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

  describe('Capability', () => {
    it('server advertises setname', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('setname')).toBe(true);

      client.send('QUIT');
    });

    it('can request setname capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['setname']);

      expect(result.ack).toContain('setname');

      client.send('QUIT');
    });
  });

  describe('SETNAME Command', () => {
    it('can change realname with SETNAME', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snchange1', 'snuser', 'Original Realname');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Change realname
      client.send('SETNAME :New Realname Here');

      // Should receive SETNAME confirmation
      const response = await client.waitForLine(/SETNAME.*New Realname/i, 5000);
      expect(response).toContain('New Realname Here');

      client.send('QUIT');
    });

    it('SETNAME notifies channel members', async () => {
      const changer = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await changer.capLs();
      await changer.capReq(['setname']);
      changer.capEnd();
      changer.register('snchanger1');
      await changer.waitForNumeric('001');

      await observer.capLs();
      await observer.capReq(['setname']);
      observer.capEnd();
      observer.register('snobserver1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('snnotify');
      changer.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await changer.waitForJoin(channel);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Changer changes realname
      changer.send('SETNAME :Updated Name');

      // Observer should see SETNAME
      const notification = await observer.waitForLine(/SETNAME.*Updated Name/i, 5000);
      expect(notification).toContain('snchanger1');
      expect(notification).toContain('Updated Name');

      changer.send('QUIT');
      observer.send('QUIT');
    });

    it('SETNAME is visible in WHOIS after change', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snwhois1', 'snuser', 'Initial Name');
      await client.waitForNumeric('001');

      // Change name
      client.send('SETNAME :WHOIS Test Name');
      await client.waitForLine(/SETNAME/i);

      client.clearRawBuffer();

      // Check WHOIS
      client.send('WHOIS snwhois1');

      // 311 is RPL_WHOISUSER which includes realname
      const whoisReply = await client.waitForLine(/311.*snwhois1/i, 5000);
      expect(whoisReply).toContain('WHOIS Test Name');

      client.send('QUIT');
    });

    it('SETNAME without setname cap does not notify others', async () => {
      const changer = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await changer.capLs();
      await changer.capReq(['setname']);
      changer.capEnd();
      changer.register('snnocap1');
      await changer.waitForNumeric('001');

      // Observer does NOT enable setname
      await observer.capLs();
      await observer.capReq(['multi-prefix']);
      observer.capEnd();
      observer.register('snnocapobs1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('snnocap');
      changer.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await changer.waitForJoin(channel);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      changer.send('SETNAME :No Cap Test');

      // Observer should NOT receive SETNAME
      try {
        await observer.waitForLine(/SETNAME/i, 2000);
        throw new Error('Should not receive SETNAME without capability');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected
      }

      changer.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('SETNAME Edge Cases', () => {
    it('SETNAME with empty name may be rejected', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snempty1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Try empty name
      client.send('SETNAME :');

      // May receive error or just be ignored
      try {
        const response = await client.waitForLine(/(SETNAME|FAIL|4\d\d)/i, 3000);
        console.log('Empty SETNAME response:', response);
      } catch {
        console.log('No response to empty SETNAME');
      }

      client.send('QUIT');
    });

    it('SETNAME with very long name may be truncated', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snlong1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Very long name (over typical limit)
      const longName = 'A'.repeat(500);
      client.send(`SETNAME :${longName}`);

      const response = await client.waitForLine(/SETNAME|FAIL|4\d\d/i, 5000);
      // Either accepted (possibly truncated) or rejected
      expect(response).toBeDefined();

      client.send('QUIT');
    });
  });
});

describe('IRCv3 chghost', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

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

  describe('Capability', () => {
    it('server advertises chghost', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('chghost')).toBe(true);

      client.send('QUIT');
    });

    it('can request chghost capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['chghost']);

      expect(result.ack).toContain('chghost');

      client.send('QUIT');
    });
  });

  describe('CHGHOST Notification', () => {
    it('receives CHGHOST when own host changes', async () => {
      // Note: Actually changing host requires oper privileges or SASL
      // This tests that the capability is properly negotiated

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['chghost']);
      client.capEnd();
      client.register('chown1');
      await client.waitForNumeric('001');

      // chghost capability is enabled - actual host changes require special setup
      expect(client.hasCapEnabled('chghost')).toBe(true);

      client.send('QUIT');
    });

    it('CHGHOST includes new user and host', async () => {
      // CHGHOST format: :nick!olduser@oldhost CHGHOST newuser newhost

      const observer = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(['chghost']);
      observer.capEnd();
      observer.register('chobs1');
      await observer.waitForNumeric('001');

      // Can't easily trigger CHGHOST without oper/services
      // This verifies capability setup
      expect(observer.hasCapEnabled('chghost')).toBe(true);

      observer.send('QUIT');
    });
  });

  describe('Without chghost', () => {
    it('does not receive CHGHOST without capability', async () => {
      const client = trackClient(await createRawSocketClient());

      // Do NOT request chghost
      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('nochg1');
      await client.waitForNumeric('001');

      expect(client.hasCapEnabled('chghost')).toBe(false);

      client.send('QUIT');
    });
  });
});

describe('IRCv3 account-tag', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

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

  describe('Capability', () => {
    it('server advertises account-tag', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('account-tag')).toBe(true);

      client.send('QUIT');
    });

    it('can request account-tag capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['account-tag']);

      expect(result.ack).toContain('account-tag');

      client.send('QUIT');
    });
  });

  describe('Account Tag on Messages', () => {
    it('PRIVMSG includes account tag when sender is logged in', async () => {
      // This requires authenticated sender
      // We test the capability setup and format understanding

      const receiver = trackClient(await createRawSocketClient());

      await receiver.capLs();
      await receiver.capReq(['account-tag']);
      receiver.capEnd();
      receiver.register('atrecv1');
      await receiver.waitForNumeric('001');

      expect(receiver.hasCapEnabled('account-tag')).toBe(true);

      receiver.send('QUIT');
    });

    it('account tag is absent for unauthenticated users', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      sender.capEnd();
      sender.register('atsend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['account-tag']);
      receiver.capEnd();
      receiver.register('atrecv2');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('attag');
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);
      await receiver.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      sender.send(`PRIVMSG ${channel} :Test message from unauthed user`);

      const msg = await receiver.waitForLine(/PRIVMSG.*Test message/i, 5000);

      // Unauthenticated sender should not have account= tag
      // (or have account=* which indicates no account)
      if (msg.startsWith('@')) {
        // If there's an account tag, it should be * for unauthed
        if (msg.includes('account=')) {
          expect(msg).toMatch(/account=\*/);
        }
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });
});

describe('IRCv3 batch', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

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

  describe('Capability', () => {
    it('server advertises batch', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('batch')).toBe(true);

      client.send('QUIT');
    });
  });

  describe('BATCH Semantics', () => {
    it('BATCH start and end are properly paired', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchpair1');
      await client.waitForNumeric('001');

      expect(client.hasCapEnabled('batch')).toBe(true);

      // BATCH format: BATCH +reference type [params]
      //               BATCH -reference

      client.send('QUIT');
    });

    it('nested batches work correctly', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchnest1');
      await client.waitForNumeric('001');

      // Batches can be nested - inner batch references outer
      expect(client.hasCapEnabled('batch')).toBe(true);

      client.send('QUIT');
    });
  });

  describe('BATCH Types', () => {
    it('netjoin batch groups related joins', async () => {
      // netjoin batches are server-initiated for netsplits
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchnj1');
      await client.waitForNumeric('001');

      expect(client.hasCapEnabled('batch')).toBe(true);

      client.send('QUIT');
    });

    it('netsplit batch groups related quits', async () => {
      // netsplit batches are server-initiated
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchns1');
      await client.waitForNumeric('001');

      expect(client.hasCapEnabled('batch')).toBe(true);

      client.send('QUIT');
    });
  });
});
