import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from './helpers/index.js';

/**
 * Error Condition Tests
 *
 * Tests that the server correctly returns IRC error codes for various error conditions.
 * These tests verify the server properly validates input and returns appropriate errors.
 */
describe('Error Conditions', () => {
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

  describe('ERR_NEEDMOREPARAMS (461)', () => {
    it('PRIVMSG with no target', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('PRIVMSG');

      // Nefarious sends ERR_NORECIPIENT (411) for PRIVMSG with no target
      const errorResponse = await client.waitForLine(/411/i, 5000);
      expect(errorResponse).toMatch(/411/);

      client.send('QUIT');
    });

    it('JOIN with no channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser2');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('JOIN');

      // Should get ERR_NEEDMOREPARAMS (461)
      const errorResponse = await client.waitForLine(/461/i, 5000);
      expect(errorResponse).toMatch(/461/);

      client.send('QUIT');
    });

    it('MODE with no target', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser3');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('MODE');

      // Should get ERR_NEEDMOREPARAMS (461)
      const errorResponse = await client.waitForLine(/461/i, 5000);
      expect(errorResponse).toMatch(/461/);

      client.send('QUIT');
    });

    it('KICK with no channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser4');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('KICK');

      // Should get ERR_NEEDMOREPARAMS (461)
      const errorResponse = await client.waitForLine(/461/i, 5000);
      expect(errorResponse).toMatch(/461/);

      client.send('QUIT');
    });

    it('TOPIC with no channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser5');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('TOPIC');

      // Should get ERR_NEEDMOREPARAMS (461)
      const errorResponse = await client.waitForLine(/461/i, 5000);
      expect(errorResponse).toMatch(/461/);

      client.send('QUIT');
    });
  });

  describe('ERR_NOSUCHCHANNEL (403)', () => {
    it('MODE on non-existent channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser6');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('MODE #nonexistent12345 +m');

      // Should get ERR_NOSUCHCHANNEL (403) or similar
      const errorResponse = await client.waitForLine(/403|401|442/i, 5000);
      // 403 = NOSUCHCHANNEL, 442 = NOTONCHANNEL
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
    });

    it('TOPIC on non-existent channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser7');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('TOPIC #nonexistent12345 :test');

      // Should get an error (403 or 442)
      const errorResponse = await client.waitForLine(/403|442/i, 5000);
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
    });

    it('JOIN with invalid channel name', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser8');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Invalid channel name (no # prefix)
      client.send('JOIN nochanprefix');

      // Should get ERR_NOSUCHCHANNEL (403) or ERR_BADCHANMASK (476)
      const errorResponse = await client.waitForLine(/403|476/i, 5000);
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('ERR_NOTONCHANNEL (442)', () => {
    it('PART channel not joined', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser9');
      await client.waitForLine(/001/);

      // Join a different channel
      client.send('JOIN #otherchannel');
      await client.waitForLine(/JOIN.*#otherchannel/i);

      client.clearRawBuffer();

      // Try to part a channel we're not in
      client.send('PART #notjoined12345');

      // Should get ERR_NOTONCHANNEL (442) or ERR_NOSUCHCHANNEL (403)
      // depending on whether server tracks channels that exist vs user membership
      const errorResponse = await client.waitForLine(/442|403/i, 5000);
      expect(errorResponse).toMatch(/442|403/);

      client.send('QUIT');
    });

    it('KICK from channel not joined', async () => {
      const client = trackClient(await createRawSocketClient());
      const target = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('erruser10');
      await client.waitForLine(/001/);

      await target.capLs();
      target.capEnd();
      target.register('kicktarget1');
      await target.waitForLine(/001/);

      // Target joins a channel
      const channel = uniqueChannel('kicknoton');
      target.send(`JOIN ${channel}`);
      await target.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Client tries to kick from channel they're not in
      client.send(`KICK ${channel} kicktarget1 :Test`);

      // Should get ERR_NOTONCHANNEL (442) or ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await client.waitForLine(/442|482/i, 5000);
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
      target.send('QUIT');
    });
  });

  describe('ERR_CHANOPRIVSNEEDED (482)', () => {
    it('MODE +o from non-op', async () => {
      const op = trackClient(await createRawSocketClient());
      const user1 = trackClient(await createRawSocketClient());
      const user2 = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('chanop1');
      await op.waitForLine(/001/);

      await user1.capLs();
      user1.capEnd();
      user1.register('nonop1');
      await user1.waitForLine(/001/);

      await user2.capLs();
      user2.capEnd();
      user2.register('target1');
      await user2.waitForLine(/001/);

      const channel = uniqueChannel('opneeded');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user1.send(`JOIN ${channel}`);
      user2.send(`JOIN ${channel}`);
      await user1.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await user2.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user1.clearRawBuffer();

      // Non-op tries to give +o
      user1.send(`MODE ${channel} +o target1`);

      // Should get ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await user1.waitForLine(/482/i, 5000);
      expect(errorResponse).toMatch(/482/);

      op.send('QUIT');
      user1.send('QUIT');
      user2.send('QUIT');
    });

    it('KICK from non-op', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());
      const target = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('chanop2');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('nonop2');
      await user.waitForLine(/001/);

      await target.capLs();
      target.capEnd();
      target.register('target2');
      await target.waitForLine(/001/);

      const channel = uniqueChannel('kickprivs');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      target.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await target.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();

      // Non-op tries to kick
      user.send(`KICK ${channel} target2 :No`);

      // Should get ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await user.waitForLine(/482/i, 5000);
      expect(errorResponse).toMatch(/482/);

      op.send('QUIT');
      user.send('QUIT');
      target.send('QUIT');
    });
  });

  describe('ERR_USERNOTINCHANNEL (441)', () => {
    it('KICK user not in channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const outside = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('kickop1');
      await op.waitForLine(/001/);

      await outside.capLs();
      outside.capEnd();
      outside.register('outside1');
      await outside.waitForLine(/001/);

      const channel = uniqueChannel('kicknothere');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // outside does NOT join the channel

      op.clearRawBuffer();

      // Try to kick user not in channel
      op.send(`KICK ${channel} outside1 :Not here`);

      // Should get ERR_USERNOTINCHANNEL (441)
      const errorResponse = await op.waitForLine(/441/i, 5000);
      expect(errorResponse).toMatch(/441/);

      op.send('QUIT');
      outside.send('QUIT');
    });
  });

  describe('ERR_NICKNAMEINUSE (433)', () => {
    it('NICK already in use', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      client1.capEnd();
      client1.register('takenname');
      await client1.waitForLine(/001/);

      await client2.capLs();
      client2.capEnd();

      client2.clearRawBuffer();

      // Try to use the same nick
      client2.send('NICK takenname');
      client2.send('USER test 0 * :Test');

      // Should get ERR_NICKNAMEINUSE (433)
      const errorResponse = await client2.waitForLine(/433/i, 5000);
      expect(errorResponse).toMatch(/433/);

      client1.send('QUIT');
      client2.close();
    });
  });

  describe('ERR_NOSUCHNICK (401)', () => {
    it('PRIVMSG to non-existent nick', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('msguser1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('PRIVMSG nonexistentnick12345 :Hello');

      // Should get ERR_NOSUCHNICK (401)
      const errorResponse = await client.waitForLine(/401/i, 5000);
      expect(errorResponse).toMatch(/401/);

      client.send('QUIT');
    });

    it('WHOIS non-existent nick', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('whoisuser1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('WHOIS nonexistentnick12345');

      // Should get ERR_NOSUCHNICK (401) or just end of WHOIS (318)
      const errorResponse = await client.waitForLine(/401|318/i, 5000);
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('ERR_INVITEONLYCHAN (473)', () => {
    it('JOIN invite-only channel without invite', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('inviteop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('inviteuser1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('inviteonly');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set +i (invite only)
      op.send(`MODE ${channel} +i`);
      await op.waitForLine(/MODE.*\+i/i, 5000);

      user.clearRawBuffer();

      // Try to join without invite
      user.send(`JOIN ${channel}`);

      // Should get ERR_INVITEONLYCHAN (473)
      const errorResponse = await user.waitForLine(/473/i, 5000);
      expect(errorResponse).toMatch(/473/);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('ERR_CHANNELISFULL (471)', () => {
    it('JOIN full channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('limitop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('limituser1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('limited');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set limit to 1
      op.send(`MODE ${channel} +l 1`);
      await op.waitForLine(/MODE.*\+l/i, 5000);

      user.clearRawBuffer();

      // Try to join full channel
      user.send(`JOIN ${channel}`);

      // Should get ERR_CHANNELISFULL (471)
      const errorResponse = await user.waitForLine(/471/i, 5000);
      expect(errorResponse).toMatch(/471/);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('ERR_BANNEDFROMCHAN (474)', () => {
    it('JOIN channel when banned', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('banop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('banned1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('banned');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Ban the user
      op.send(`MODE ${channel} +b banned1!*@*`);
      await op.waitForLine(/MODE.*\+b/i, 5000);

      user.clearRawBuffer();

      // Try to join when banned
      user.send(`JOIN ${channel}`);

      // Should get ERR_BANNEDFROMCHAN (474)
      const errorResponse = await user.waitForLine(/474/i, 5000);
      expect(errorResponse).toMatch(/474/);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('ERR_BADCHANNELKEY (475)', () => {
    it('JOIN channel with wrong key', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('keyop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('keyuser1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('keyed');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set channel key
      op.send(`MODE ${channel} +k secretkey`);
      await op.waitForLine(/MODE.*\+k/i, 5000);

      user.clearRawBuffer();

      // Try to join with wrong key
      user.send(`JOIN ${channel} wrongkey`);

      // Should get ERR_BADCHANNELKEY (475)
      const errorResponse = await user.waitForLine(/475/i, 5000);
      expect(errorResponse).toMatch(/475/);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('ERR_CANNOTSENDTOCHAN (404)', () => {
    it('PRIVMSG to +n channel from outside', async () => {
      const inside = trackClient(await createRawSocketClient());
      const outside = trackClient(await createRawSocketClient());

      await inside.capLs();
      inside.capEnd();
      inside.register('inside1');
      await inside.waitForLine(/001/);

      await outside.capLs();
      outside.capEnd();
      outside.register('outside2');
      await outside.waitForLine(/001/);

      const channel = uniqueChannel('noexternal');
      inside.send(`JOIN ${channel}`);
      await inside.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Ensure +n is set (default usually)
      inside.send(`MODE ${channel} +n`);
      await inside.waitForLine(/MODE.*\+n/i, 5000).catch(() => {});

      outside.clearRawBuffer();

      // Try to message channel from outside
      outside.send(`PRIVMSG ${channel} :Hello from outside`);

      // Should get ERR_CANNOTSENDTOCHAN (404)
      const errorResponse = await outside.waitForLine(/404/i, 5000);
      expect(errorResponse).toMatch(/404/);

      inside.send('QUIT');
      outside.send('QUIT');
    });
  });
});
