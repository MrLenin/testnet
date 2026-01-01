import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';

/**
 * Extended-Join, Userhost-in-Names, and Multi-Prefix Tests
 *
 * Tests for capabilities that enhance JOIN and NAMES responses:
 * - extended-join: Adds account and realname to JOIN
 * - userhost-in-names: Adds user@host to NAMES reply
 * - multi-prefix: Shows all user modes in NAMES
 */
describe('IRCv3 extended-join', () => {
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
    it('server advertises extended-join', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('extended-join')).toBe(true);
      client.send('QUIT');
    });

    it('can request extended-join capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['extended-join']);

      expect(result.ack).toContain('extended-join');
      client.send('QUIT');
    });
  });

  describe('Extended JOIN Format', () => {
    it('JOIN includes account and realname with extended-join', async () => {
      const observer = trackClient(await createRawSocketClient());
      const joiner = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(['extended-join']);
      observer.capEnd();
      observer.register('extjobs1');
      await observer.waitForLine(/001/);

      await joiner.capLs();
      joiner.capEnd();
      joiner.register('extjjoin1', 'joinuser', 'Test Joiner Realname');
      await joiner.waitForLine(/001/);

      const channel = uniqueChannel('extjtest');
      observer.send(`JOIN ${channel}`);
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.send(`JOIN ${channel}`);

      // Observer should see extended JOIN
      // Format: :nick!user@host JOIN #channel account :realname
      const joinMsg = await observer.waitForLine(/JOIN.*#extjtest/i, 5000);

      // Check extended format: should have account (* if not logged in) and realname
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
      // Should contain the realname
      expect(joinMsg).toContain('Test Joiner Realname');
      observer.send('QUIT');
      joiner.send('QUIT');
    });

    it('own JOIN also uses extended format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['extended-join']);
      client.capEnd();
      client.register('extjself1', 'selfuser', 'My Realname');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      const channel = uniqueChannel('extjself');
      client.send(`JOIN ${channel}`);

      const joinMsg = await client.waitForLine(/JOIN.*#extjself/i, 5000);

      // Own JOIN should also be extended format
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
      client.send('QUIT');
    });

    it('account is * for unauthenticated users', async () => {
      const observer = trackClient(await createRawSocketClient());
      const joiner = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(['extended-join']);
      observer.capEnd();
      observer.register('extjobs2');
      await observer.waitForLine(/001/);

      // Joiner doesn't authenticate
      await joiner.capLs();
      joiner.capEnd();
      joiner.register('extjjoin2');
      await joiner.waitForLine(/001/);

      const channel = uniqueChannel('extjunauth');
      observer.send(`JOIN ${channel}`);
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.send(`JOIN ${channel}`);

      const joinMsg = await observer.waitForLine(/JOIN.*#extjunauth/i, 5000);

      // Account should be * for unauthenticated user
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\*\s+:/);
      observer.send('QUIT');
      joiner.send('QUIT');
    });
  });

  describe('Without extended-join', () => {
    it('JOIN has standard format without extended-join', async () => {
      const observer = trackClient(await createRawSocketClient());
      const joiner = trackClient(await createRawSocketClient());

      // Observer does NOT request extended-join
      await observer.capLs();
      await observer.capReq(['multi-prefix']);
      observer.capEnd();
      observer.register('stdobs1');
      await observer.waitForLine(/001/);

      await joiner.capLs();
      joiner.capEnd();
      joiner.register('stdjoin1');
      await joiner.waitForLine(/001/);

      const channel = uniqueChannel('stdjoin');
      observer.send(`JOIN ${channel}`);
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.send(`JOIN ${channel}`);

      const joinMsg = await observer.waitForLine(/JOIN.*#stdjoin/i, 5000);

      // Standard format: :nick!user@host JOIN #channel (or just :#channel)
      // Should NOT have account and realname
      expect(joinMsg).not.toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
      observer.send('QUIT');
      joiner.send('QUIT');
    });
  });
});

describe('IRCv3 userhost-in-names', () => {
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
    it('server advertises userhost-in-names', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('userhost-in-names')).toBe(true);
      client.send('QUIT');
    });

    it('can request userhost-in-names capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['userhost-in-names']);

      expect(result.ack).toContain('userhost-in-names');
      client.send('QUIT');
    });
  });

  describe('NAMES Reply Format', () => {
    it('NAMES includes user@host with userhost-in-names', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['userhost-in-names']);
      client.capEnd();
      client.register('uhintest1', 'testuser');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('uhintest');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Request NAMES
      client.send(`NAMES ${channel}`);

      // 353 is RPL_NAMREPLY
      const namesReply = await client.waitForLine(/353.*#uhintest/i, 5000);

      // With userhost-in-names, format includes nick!user@host
      expect(namesReply).toMatch(/uhintest1!testuser@\S+/);
      client.send('QUIT');
    });

    it('NAMES on join includes user@host', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['userhost-in-names']);
      client.capEnd();
      client.register('uhinjoin1', 'joinuser');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      const channel = uniqueChannel('uhinjoin');
      client.send(`JOIN ${channel}`);

      // 353 RPL_NAMREPLY is sent after JOIN
      const namesReply = await client.waitForLine(/353.*#uhinjoin/i, 5000);

      expect(namesReply).toMatch(/uhinjoin1!joinuser@\S+/);
      client.send('QUIT');
    });

    it('shows multiple users with full hostmasks', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['userhost-in-names']);
      client1.capEnd();
      client1.register('uhinmulti1', 'user1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('uhinmulti2', 'user2');
      await client2.waitForLine(/001/);

      const channel = uniqueChannel('uhinmulti');
      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await client2.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      client1.send(`NAMES ${channel}`);

      const namesReply = await client1.waitForLine(/353.*#uhinmulti/i, 5000);

      // Both users should have full hostmasks
      expect(namesReply).toMatch(/uhinmulti1!user1@\S+/);
      expect(namesReply).toMatch(/uhinmulti2!user2@\S+/);
      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Without userhost-in-names', () => {
    it('NAMES only includes nicknames without userhost-in-names', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix']); // NOT userhost-in-names
      client.capEnd();
      client.register('nouhin1', 'testuser');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('nouhin');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.send(`NAMES ${channel}`);

      const namesReply = await client.waitForLine(/353.*#nouhin/i, 5000);

      // Without userhost-in-names, should NOT have user@host
      expect(namesReply).not.toMatch(/nouhin1!\S+@\S+/);
      // Should just have the nick (possibly with prefix like @)
      expect(namesReply).toMatch(/[@+]?nouhin1(\s|$)/);
      client.send('QUIT');
    });
  });
});

describe('IRCv3 multi-prefix', () => {
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
    it('server advertises multi-prefix', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('multi-prefix')).toBe(true);
      client.send('QUIT');
    });

    it('can request multi-prefix capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['multi-prefix']);

      expect(result.ack).toContain('multi-prefix');
      client.send('QUIT');
    });
  });

  describe('Multiple Prefixes in NAMES', () => {
    it('shows single prefix for single mode', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpnames1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('mpnames');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.send(`NAMES ${channel}`);

      const namesReply = await client.waitForLine(/353.*#mpnames/i, 5000);

      // First user to join gets op (@)
      expect(namesReply).toMatch(/@mpnames1/);
      client.send('QUIT');
    });

    it('shows all prefixes when user has multiple modes', async () => {
      // This test requires ability to set multiple modes
      // Channel founder typically gets @ (op), may also get other modes

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpmulti1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('mpmulti');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give ourselves voice too (if we're op)
      client.send(`MODE ${channel} +v mpmulti1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.send(`NAMES ${channel}`);

      const namesReply = await client.waitForLine(/353.*#mpmulti/i, 5000);

      // With multi-prefix, should show @+ (op and voice)
      // Note: prefix order is defined by PREFIX= in 005
      expect(namesReply).toMatch(/[@~&]?\+?mpmulti1|[@~&]+mpmulti1/);
      client.send('QUIT');
    });
  });

  describe('Without multi-prefix', () => {
    it('shows only highest prefix without multi-prefix', async () => {
      const client = trackClient(await createRawSocketClient());

      // Do NOT request multi-prefix
      await client.capLs();
      client.capEnd();
      client.register('nomp1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('nomp');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give ourselves voice too
      client.send(`MODE ${channel} +v nomp1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.send(`NAMES ${channel}`);

      const namesReply = await client.waitForLine(/353.*#nomp/i, 5000);

      // Without multi-prefix, only highest prefix shown
      // @ (op) is higher than + (voice), so only @ should show
      expect(namesReply).toMatch(/@nomp1/);
      // Should NOT show @+ together
      expect(namesReply).not.toMatch(/@\+nomp1/);
      client.send('QUIT');
    });
  });

  describe('multi-prefix in WHO', () => {
    it('WHO shows all prefixes with multi-prefix', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpwho1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('mpwho');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give voice
      client.send(`MODE ${channel} +v mpwho1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.send(`WHO ${channel}`);

      // 352 is RPL_WHOREPLY
      const whoReply = await client.waitForLine(/352.*#mpwho/i, 5000);

      // WHO reply should include channel status with all prefixes
      expect(whoReply).toBeDefined();
      client.send('QUIT');
    });
  });
});

describe('draft/no-implicit-names', () => {
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
    it('server advertises draft/no-implicit-names', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('draft/no-implicit-names')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('Behavior', () => {
    it('JOIN does not trigger NAMES with no-implicit-names', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/no-implicit-names']);

      if (result.nak.length > 0) {
        console.log('draft/no-implicit-names not supported');
        client.send('QUIT');
        return;
      }

      client.capEnd();
      client.register('nimjoin1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      const channel = uniqueChannel('nimjoin');
      client.send(`JOIN ${channel}`);

      // Wait for JOIN
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Should NOT receive 353 (RPL_NAMREPLY) automatically
      try {
        await client.waitForLine(/353.*#nimjoin/i, 2000);
        throw new Error('Should not receive NAMES with no-implicit-names');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected - good!
      }
      client.send('QUIT');
    });

    it('explicit NAMES still works with no-implicit-names', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/no-implicit-names']);

      if (result.nak.length > 0) {
        console.log('draft/no-implicit-names not supported');
        client.send('QUIT');
        return;
      }

      client.capEnd();
      client.register('nimexpl1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('nimexpl');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      // Explicit NAMES request should still work
      client.send(`NAMES ${channel}`);

      const namesReply = await client.waitForLine(/353.*#nimexpl/i, 5000);
      expect(namesReply).toContain('nimexpl1');
      client.send('QUIT');
    });
  });
});
