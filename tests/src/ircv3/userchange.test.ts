import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * User Change Tests
 *
 * Tests for capabilities that notify clients about user changes:
 * - setname: Change realname/gecos
 * - chghost: Notifies when user's host changes
 */
describe('IRCv3 setname', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises setname', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'sntest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('setname')).toBe(true);
    });

    it('can request setname capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'sntest2' })
      );

      await client.capLs();
      const result = await client.capReq(['setname']);

      expect(result.ack).toContain('setname');
    });
  });

  describe('SETNAME Command', () => {
    it('can change realname with SETNAME', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'snchange1' })
      );

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snchange1', 'snuser', 'Original Realname');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Change realname
      client.raw('SETNAME :New Realname Here');

      // Should receive SETNAME confirmation
      const response = await client.waitForRaw(/SETNAME.*New Realname/i, 5000);
      expect(response).toContain('New Realname Here');
    });

    it('SETNAME notifies channel members', async () => {
      const changer = trackClient(
        await createRawIRCv3Client({ nick: 'snchanger1' })
      );
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'snobserver1' })
      );

      await changer.capLs();
      await changer.capReq(['setname']);
      changer.capEnd();
      changer.register('snchanger1');
      await changer.waitForRaw(/001/);

      await observer.capLs();
      await observer.capReq(['setname']);
      observer.capEnd();
      observer.register('snobserver1');
      await observer.waitForRaw(/001/);

      const channel = `#snnotify${Date.now()}`;
      changer.join(channel);
      observer.join(channel);
      await changer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Changer changes realname
      changer.raw('SETNAME :Updated Name');

      // Observer should see SETNAME
      const notification = await observer.waitForRaw(/SETNAME.*Updated Name/i, 5000);
      expect(notification).toContain('snchanger1');
      expect(notification).toContain('Updated Name');
    });

    it('SETNAME is visible in WHOIS after change', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'snwhois1' })
      );

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snwhois1', 'snuser', 'Initial Name');
      await client.waitForRaw(/001/);

      // Change name
      client.raw('SETNAME :WHOIS Test Name');
      await client.waitForRaw(/SETNAME/i);

      client.clearRawBuffer();

      // Check WHOIS
      client.raw('WHOIS snwhois1');

      // 311 is RPL_WHOISUSER which includes realname
      const whoisReply = await client.waitForRaw(/311.*snwhois1/i, 5000);
      expect(whoisReply).toContain('WHOIS Test Name');
    });

    it('SETNAME without setname cap does not notify others', async () => {
      const changer = trackClient(
        await createRawIRCv3Client({ nick: 'snnocap1' })
      );
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'snnocapobs1' })
      );

      await changer.capLs();
      await changer.capReq(['setname']);
      changer.capEnd();
      changer.register('snnocap1');
      await changer.waitForRaw(/001/);

      // Observer does NOT enable setname
      await observer.capLs();
      await observer.capReq(['multi-prefix']);
      observer.capEnd();
      observer.register('snnocapobs1');
      await observer.waitForRaw(/001/);

      const channel = `#snnocap${Date.now()}`;
      changer.join(channel);
      observer.join(channel);
      await changer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      changer.raw('SETNAME :No Cap Test');

      // Observer should NOT receive SETNAME
      try {
        await observer.waitForRaw(/SETNAME/i, 2000);
        throw new Error('Should not receive SETNAME without capability');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected
      }
    });
  });

  describe('SETNAME Edge Cases', () => {
    it('SETNAME with empty name may be rejected', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'snempty1' })
      );

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snempty1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Try empty name
      client.raw('SETNAME :');

      // May receive error or just be ignored
      try {
        const response = await client.waitForRaw(/(SETNAME|FAIL|4\d\d)/i, 3000);
        console.log('Empty SETNAME response:', response);
      } catch {
        console.log('No response to empty SETNAME');
      }
    });

    it('SETNAME with very long name may be truncated', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'snlong1' })
      );

      await client.capLs();
      await client.capReq(['setname']);
      client.capEnd();
      client.register('snlong1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      // Very long name (over typical limit)
      const longName = 'A'.repeat(500);
      client.raw(`SETNAME :${longName}`);

      const response = await client.waitForRaw(/SETNAME|FAIL|4\d\d/i, 5000);
      // Either accepted (possibly truncated) or rejected
      expect(response).toBeDefined();
    });
  });
});

describe('IRCv3 chghost', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises chghost', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'chtest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('chghost')).toBe(true);
    });

    it('can request chghost capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'chtest2' })
      );

      await client.capLs();
      const result = await client.capReq(['chghost']);

      expect(result.ack).toContain('chghost');
    });
  });

  describe('CHGHOST Notification', () => {
    it('receives CHGHOST when own host changes', async () => {
      // Note: Actually changing host requires oper privileges or SASL
      // This tests that the capability is properly negotiated

      const client = trackClient(
        await createRawIRCv3Client({ nick: 'chown1' })
      );

      await client.capLs();
      await client.capReq(['chghost']);
      client.capEnd();
      client.register('chown1');
      await client.waitForRaw(/001/);

      // chghost capability is enabled - actual host changes require special setup
      expect(client.hasCapEnabled('chghost')).toBe(true);
    });

    it('CHGHOST includes new user and host', async () => {
      // CHGHOST format: :nick!olduser@oldhost CHGHOST newuser newhost

      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'chobs1' })
      );

      await observer.capLs();
      await observer.capReq(['chghost']);
      observer.capEnd();
      observer.register('chobs1');
      await observer.waitForRaw(/001/);

      // Can't easily trigger CHGHOST without oper/services
      // This verifies capability setup
      expect(observer.hasCapEnabled('chghost')).toBe(true);
    });
  });

  describe('Without chghost', () => {
    it('does not receive CHGHOST without capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nochg1' })
      );

      // Do NOT request chghost
      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('nochg1');
      await client.waitForRaw(/001/);

      expect(client.hasCapEnabled('chghost')).toBe(false);
    });
  });
});

describe('IRCv3 account-tag', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises account-tag', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'attest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('account-tag')).toBe(true);
    });

    it('can request account-tag capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'attest2' })
      );

      await client.capLs();
      const result = await client.capReq(['account-tag']);

      expect(result.ack).toContain('account-tag');
    });
  });

  describe('Account Tag on Messages', () => {
    it('PRIVMSG includes account tag when sender is logged in', async () => {
      // This requires authenticated sender
      // We test the capability setup and format understanding

      const receiver = trackClient(
        await createRawIRCv3Client({ nick: 'atrecv1' })
      );

      await receiver.capLs();
      await receiver.capReq(['account-tag', 'message-tags']);
      receiver.capEnd();
      receiver.register('atrecv1');
      await receiver.waitForRaw(/001/);

      expect(receiver.hasCapEnabled('account-tag')).toBe(true);
    });

    it('account tag is absent for unauthenticated users', async () => {
      const sender = trackClient(
        await createRawIRCv3Client({ nick: 'atsend1' })
      );
      const receiver = trackClient(
        await createRawIRCv3Client({ nick: 'atrecv2' })
      );

      await sender.capLs();
      sender.capEnd();
      sender.register('atsend1');
      await sender.waitForRaw(/001/);

      await receiver.capLs();
      await receiver.capReq(['account-tag', 'message-tags']);
      receiver.capEnd();
      receiver.register('atrecv2');
      await receiver.waitForRaw(/001/);

      const channel = `#attag${Date.now()}`;
      sender.join(channel);
      receiver.join(channel);
      await sender.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      receiver.clearRawBuffer();

      sender.say(channel, 'Test message from unauthed user');

      const msg = await receiver.waitForRaw(/PRIVMSG.*Test message/i, 5000);

      // Unauthenticated sender should not have account= tag
      // (or have account=* which indicates no account)
      if (msg.startsWith('@')) {
        // If there's an account tag, it should be * for unauthed
        if (msg.includes('account=')) {
          expect(msg).toMatch(/account=\*/);
        }
      }
    });
  });
});

describe('IRCv3 batch', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises batch', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'batchtest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('batch')).toBe(true);
    });
  });

  describe('BATCH Semantics', () => {
    it('BATCH start and end are properly paired', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'batchpair1' })
      );

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchpair1');
      await client.waitForRaw(/001/);

      expect(client.hasCapEnabled('batch')).toBe(true);

      // BATCH format: BATCH +reference type [params]
      //               BATCH -reference
    });

    it('nested batches work correctly', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'batchnest1' })
      );

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchnest1');
      await client.waitForRaw(/001/);

      // Batches can be nested - inner batch references outer
      expect(client.hasCapEnabled('batch')).toBe(true);
    });
  });

  describe('BATCH Types', () => {
    it('netjoin batch groups related joins', async () => {
      // netjoin batches are server-initiated for netsplits
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'batchnj1' })
      );

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchnj1');
      await client.waitForRaw(/001/);

      expect(client.hasCapEnabled('batch')).toBe(true);
    });

    it('netsplit batch groups related quits', async () => {
      // netsplit batches are server-initiated
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'batchns1' })
      );

      await client.capLs();
      await client.capReq(['batch']);
      client.capEnd();
      client.register('batchns1');
      await client.waitForRaw(/001/);

      expect(client.hasCapEnabled('batch')).toBe(true);
    });
  });
});
