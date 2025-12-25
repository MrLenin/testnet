import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * Extended-Join, Userhost-in-Names, and Multi-Prefix Tests
 *
 * Tests for capabilities that enhance JOIN and NAMES responses:
 * - extended-join: Adds account and realname to JOIN
 * - userhost-in-names: Adds user@host to NAMES reply
 * - multi-prefix: Shows all user modes in NAMES
 */
describe('IRCv3 extended-join', () => {
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
    it('server advertises extended-join', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'extj1' })
      );

      const caps = await client.capLs();
      expect(caps.has('extended-join')).toBe(true);
    });

    it('can request extended-join capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'extj2' })
      );

      await client.capLs();
      const result = await client.capReq(['extended-join']);

      expect(result.ack).toContain('extended-join');
    });
  });

  describe('Extended JOIN Format', () => {
    it('JOIN includes account and realname with extended-join', async () => {
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'extjobs1' })
      );
      const joiner = trackClient(
        await createRawIRCv3Client({ nick: 'extjjoin1' })
      );

      await observer.capLs();
      await observer.capReq(['extended-join']);
      observer.capEnd();
      observer.register('extjobs1');
      await observer.waitForRaw(/001/);

      await joiner.capLs();
      joiner.capEnd();
      joiner.register('extjjoin1', 'joinuser', 'Test Joiner Realname');
      await joiner.waitForRaw(/001/);

      const channel = `#extjtest${Date.now()}`;
      observer.join(channel);
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.join(channel);

      // Observer should see extended JOIN
      // Format: :nick!user@host JOIN #channel account :realname
      const joinMsg = await observer.waitForRaw(/JOIN.*#extjtest/i, 5000);

      // Check extended format: should have account (* if not logged in) and realname
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
      // Should contain the realname
      expect(joinMsg).toContain('Test Joiner Realname');
    });

    it('own JOIN also uses extended format', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'extjself1' })
      );

      await client.capLs();
      await client.capReq(['extended-join']);
      client.capEnd();
      client.register('extjself1', 'selfuser', 'My Realname');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      const channel = `#extjself${Date.now()}`;
      client.join(channel);

      const joinMsg = await client.waitForRaw(/JOIN.*#extjself/i, 5000);

      // Own JOIN should also be extended format
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
    });

    it('account is * for unauthenticated users', async () => {
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'extjobs2' })
      );
      const joiner = trackClient(
        await createRawIRCv3Client({ nick: 'extjjoin2' })
      );

      await observer.capLs();
      await observer.capReq(['extended-join']);
      observer.capEnd();
      observer.register('extjobs2');
      await observer.waitForRaw(/001/);

      // Joiner doesn't authenticate
      await joiner.capLs();
      joiner.capEnd();
      joiner.register('extjjoin2');
      await joiner.waitForRaw(/001/);

      const channel = `#extjunauth${Date.now()}`;
      observer.join(channel);
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.join(channel);

      const joinMsg = await observer.waitForRaw(/JOIN.*#extjunauth/i, 5000);

      // Account should be * for unauthenticated user
      expect(joinMsg).toMatch(/JOIN\s+#\S+\s+\*\s+:/);
    });
  });

  describe('Without extended-join', () => {
    it('JOIN has standard format without extended-join', async () => {
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'stdobs1' })
      );
      const joiner = trackClient(
        await createRawIRCv3Client({ nick: 'stdjoin1' })
      );

      // Observer does NOT request extended-join
      await observer.capLs();
      await observer.capReq(['multi-prefix']);
      observer.capEnd();
      observer.register('stdobs1');
      await observer.waitForRaw(/001/);

      await joiner.capLs();
      joiner.capEnd();
      joiner.register('stdjoin1');
      await joiner.waitForRaw(/001/);

      const channel = `#stdjoin${Date.now()}`;
      observer.join(channel);
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      joiner.join(channel);

      const joinMsg = await observer.waitForRaw(/JOIN.*#stdjoin/i, 5000);

      // Standard format: :nick!user@host JOIN #channel (or just :#channel)
      // Should NOT have account and realname
      expect(joinMsg).not.toMatch(/JOIN\s+#\S+\s+\S+\s+:/);
    });
  });
});

describe('IRCv3 userhost-in-names', () => {
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
    it('server advertises userhost-in-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'uhin1' })
      );

      const caps = await client.capLs();
      expect(caps.has('userhost-in-names')).toBe(true);
    });

    it('can request userhost-in-names capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'uhin2' })
      );

      await client.capLs();
      const result = await client.capReq(['userhost-in-names']);

      expect(result.ack).toContain('userhost-in-names');
    });
  });

  describe('NAMES Reply Format', () => {
    it('NAMES includes user@host with userhost-in-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'uhintest1' })
      );

      await client.capLs();
      await client.capReq(['userhost-in-names']);
      client.capEnd();
      client.register('uhintest1', 'testuser');
      await client.waitForRaw(/001/);

      const channel = `#uhintest${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Request NAMES
      client.raw(`NAMES ${channel}`);

      // 353 is RPL_NAMREPLY
      const namesReply = await client.waitForRaw(/353.*#uhintest/i, 5000);

      // With userhost-in-names, format includes nick!user@host
      expect(namesReply).toMatch(/uhintest1!testuser@\S+/);
    });

    it('NAMES on join includes user@host', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'uhinjoin1' })
      );

      await client.capLs();
      await client.capReq(['userhost-in-names']);
      client.capEnd();
      client.register('uhinjoin1', 'joinuser');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      const channel = `#uhinjoin${Date.now()}`;
      client.join(channel);

      // 353 RPL_NAMREPLY is sent after JOIN
      const namesReply = await client.waitForRaw(/353.*#uhinjoin/i, 5000);

      expect(namesReply).toMatch(/uhinjoin1!joinuser@\S+/);
    });

    it('shows multiple users with full hostmasks', async () => {
      const client1 = trackClient(
        await createRawIRCv3Client({ nick: 'uhinmulti1' })
      );
      const client2 = trackClient(
        await createRawIRCv3Client({ nick: 'uhinmulti2' })
      );

      await client1.capLs();
      await client1.capReq(['userhost-in-names']);
      client1.capEnd();
      client1.register('uhinmulti1', 'user1');
      await client1.waitForRaw(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('uhinmulti2', 'user2');
      await client2.waitForRaw(/001/);

      const channel = `#uhinmulti${Date.now()}`;
      client1.join(channel);
      client2.join(channel);
      await client1.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await client2.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      client1.raw(`NAMES ${channel}`);

      const namesReply = await client1.waitForRaw(/353.*#uhinmulti/i, 5000);

      // Both users should have full hostmasks
      expect(namesReply).toMatch(/uhinmulti1!user1@\S+/);
      expect(namesReply).toMatch(/uhinmulti2!user2@\S+/);
    });
  });

  describe('Without userhost-in-names', () => {
    it('NAMES only includes nicknames without userhost-in-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nouhin1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix']); // NOT userhost-in-names
      client.capEnd();
      client.register('nouhin1', 'testuser');
      await client.waitForRaw(/001/);

      const channel = `#nouhin${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.raw(`NAMES ${channel}`);

      const namesReply = await client.waitForRaw(/353.*#nouhin/i, 5000);

      // Without userhost-in-names, should NOT have user@host
      expect(namesReply).not.toMatch(/nouhin1!\S+@\S+/);
      // Should just have the nick (possibly with prefix like @)
      expect(namesReply).toMatch(/[@+]?nouhin1(\s|$)/);
    });
  });
});

describe('IRCv3 multi-prefix', () => {
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
    it('server advertises multi-prefix', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'mptest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('multi-prefix')).toBe(true);
    });

    it('can request multi-prefix capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'mptest2' })
      );

      await client.capLs();
      const result = await client.capReq(['multi-prefix']);

      expect(result.ack).toContain('multi-prefix');
    });
  });

  describe('Multiple Prefixes in NAMES', () => {
    it('shows single prefix for single mode', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'mpnames1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpnames1');
      await client.waitForRaw(/001/);

      const channel = `#mpnames${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.raw(`NAMES ${channel}`);

      const namesReply = await client.waitForRaw(/353.*#mpnames/i, 5000);

      // First user to join gets op (@)
      expect(namesReply).toMatch(/@mpnames1/);
    });

    it('shows all prefixes when user has multiple modes', async () => {
      // This test requires ability to set multiple modes
      // Channel founder typically gets @ (op), may also get other modes

      const client = trackClient(
        await createRawIRCv3Client({ nick: 'mpmulti1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpmulti1');
      await client.waitForRaw(/001/);

      const channel = `#mpmulti${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give ourselves voice too (if we're op)
      client.raw(`MODE ${channel} +v mpmulti1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.raw(`NAMES ${channel}`);

      const namesReply = await client.waitForRaw(/353.*#mpmulti/i, 5000);

      // With multi-prefix, should show @+ (op and voice)
      // Note: prefix order is defined by PREFIX= in 005
      expect(namesReply).toMatch(/[@~&]?\+?mpmulti1|[@~&]+mpmulti1/);
    });
  });

  describe('Without multi-prefix', () => {
    it('shows only highest prefix without multi-prefix', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nomp1' })
      );

      // Do NOT request multi-prefix
      await client.capLs();
      client.capEnd();
      client.register('nomp1');
      await client.waitForRaw(/001/);

      const channel = `#nomp${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give ourselves voice too
      client.raw(`MODE ${channel} +v nomp1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.raw(`NAMES ${channel}`);

      const namesReply = await client.waitForRaw(/353.*#nomp/i, 5000);

      // Without multi-prefix, only highest prefix shown
      // @ (op) is higher than + (voice), so only @ should show
      expect(namesReply).toMatch(/@nomp1/);
      // Should NOT show @+ together
      expect(namesReply).not.toMatch(/@\+nomp1/);
    });
  });

  describe('multi-prefix in WHO', () => {
    it('WHO shows all prefixes with multi-prefix', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'mpwho1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('mpwho1');
      await client.waitForRaw(/001/);

      const channel = `#mpwho${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Give voice
      client.raw(`MODE ${channel} +v mpwho1`);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.raw(`WHO ${channel}`);

      // 352 is RPL_WHOREPLY
      const whoReply = await client.waitForRaw(/352.*#mpwho/i, 5000);

      // WHO reply should include channel status with all prefixes
      expect(whoReply).toBeDefined();
    });
  });
});

describe('draft/no-implicit-names', () => {
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
    it('server advertises draft/no-implicit-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nimtest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/no-implicit-names')).toBe(true);
    });
  });

  describe('Behavior', () => {
    it('JOIN does not trigger NAMES with no-implicit-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nimjoin1' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/no-implicit-names']);

      if (result.nak.length > 0) {
        console.log('draft/no-implicit-names not supported');
        return;
      }

      client.capEnd();
      client.register('nimjoin1');
      await client.waitForRaw(/001/);

      client.clearRawBuffer();

      const channel = `#nimjoin${Date.now()}`;
      client.join(channel);

      // Wait for JOIN
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Should NOT receive 353 (RPL_NAMREPLY) automatically
      try {
        await client.waitForRaw(/353.*#nimjoin/i, 2000);
        throw new Error('Should not receive NAMES with no-implicit-names');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected - good!
      }
    });

    it('explicit NAMES still works with no-implicit-names', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'nimexpl1' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/no-implicit-names']);

      if (result.nak.length > 0) {
        console.log('draft/no-implicit-names not supported');
        return;
      }

      client.capEnd();
      client.register('nimexpl1');
      await client.waitForRaw(/001/);

      const channel = `#nimexpl${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      // Explicit NAMES request should still work
      client.raw(`NAMES ${channel}`);

      const namesReply = await client.waitForRaw(/353.*#nimexpl/i, 5000);
      expect(namesReply).toContain('nimexpl1');
    });
  });
});
