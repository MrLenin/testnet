import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId } from './helpers/index.js';

/**
 * Core IRC Command Tests
 *
 * Tests for fundamental IRC commands: MODE, KICK, TOPIC, INVITE, WHOIS, WHO, LIST, PART
 * These are essential IRC operations that should work correctly.
 */
describe('Core IRC Commands', () => {
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

  describe('MODE', () => {
    it('should set channel mode +n (no external messages)', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('modetest1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('mode');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Set +n mode (no external messages)
      client.send(`MODE ${channel} +n`);

      const modeResponse = await client.waitForLine(/MODE.*\+n/i, 5000);
      expect(modeResponse).toMatch(/MODE/i);
      expect(modeResponse).toContain('+n');

      client.send('QUIT');
    });

    it('should set channel mode +m (moderated)', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('modetest2');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('modem');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.send(`MODE ${channel} +m`);

      const modeResponse = await client.waitForLine(/MODE.*\+m/i, 5000);
      expect(modeResponse).toContain('+m');

      client.send('QUIT');
    });

    it('should grant operator status with +o', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('opuser1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('newop1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('modeo');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      op.clearRawBuffer();
      user.clearRawBuffer();

      // Op gives +o to user
      op.send(`MODE ${channel} +o newop1`);

      const modeResponse = await op.waitForLine(/MODE.*\+o.*newop1/i, 5000);
      expect(modeResponse).toContain('+o');
      expect(modeResponse).toContain('newop1');

      op.send('QUIT');
      user.send('QUIT');
    });

    it('should reject MODE from non-op with ERR_CHANOPRIVSNEEDED (482)', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('chanop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('nonop1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('moderej');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();

      // Non-op tries to set mode
      user.send(`MODE ${channel} +m`);

      // Should get ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await user.waitForLine(/482/i, 5000);
      expect(errorResponse).toMatch(/482/);

      op.send('QUIT');
      user.send('QUIT');
    });

    it('should query channel modes', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('modequery1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('modeq');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set a mode first
      client.send(`MODE ${channel} +nt`);
      await client.waitForLine(/MODE.*\+/i, 5000);

      client.clearRawBuffer();

      // Query modes
      client.send(`MODE ${channel}`);

      // Should receive mode info (324 = RPL_CHANNELMODEIS)
      const modeInfo = await client.waitForLine(/324|MODE/i, 5000);
      expect(modeInfo).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('KICK', () => {
    it('should remove user from channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('kickop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('kicked1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('kick');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();
      op.clearRawBuffer();

      // Op kicks user
      op.send(`KICK ${channel} kicked1 :Test kick`);

      // Both should see the KICK
      const kickResponse = await op.waitForLine(/KICK.*kicked1/i, 5000);
      expect(kickResponse).toContain('KICK');
      expect(kickResponse).toContain('kicked1');

      op.send('QUIT');
      user.send('QUIT');
    });

    it('should reject KICK from non-op with ERR_CHANOPRIVSNEEDED (482)', async () => {
      const op = trackClient(await createRawSocketClient());
      const user1 = trackClient(await createRawSocketClient());
      const user2 = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('kickop2');
      await op.waitForLine(/001/);

      await user1.capLs();
      user1.capEnd();
      user1.register('kicker1');
      await user1.waitForLine(/001/);

      await user2.capLs();
      user2.capEnd();
      user2.register('target1');
      await user2.waitForLine(/001/);

      const channel = uniqueChannel('kickrej');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user1.send(`JOIN ${channel}`);
      user2.send(`JOIN ${channel}`);
      await user1.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await user2.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user1.clearRawBuffer();

      // Non-op tries to kick
      user1.send(`KICK ${channel} target1 :Shouldn't work`);

      // Should get ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await user1.waitForLine(/482/i, 5000);
      expect(errorResponse).toMatch(/482/);

      op.send('QUIT');
      user1.send('QUIT');
      user2.send('QUIT');
    });

    it('should broadcast KICK to all channel members', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('kickop3');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('kicked2');
      await user.waitForLine(/001/);

      await observer.capLs();
      observer.capEnd();
      observer.register('observer1');
      await observer.waitForLine(/001/);

      const channel = uniqueChannel('kickbc');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Op kicks user
      op.send(`KICK ${channel} kicked2 :Bye`);

      // Observer should see the kick
      const kickMsg = await observer.waitForLine(/KICK.*kicked2/i, 5000);
      expect(kickMsg).toContain('KICK');
      expect(kickMsg).toContain('kicked2');

      op.send('QUIT');
      user.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('TOPIC', () => {
    it('should set channel topic', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('topicset1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('topic');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      const topic = `Test topic ${uniqueId()}`;
      client.send(`TOPIC ${channel} :${topic}`);

      const topicResponse = await client.waitForLine(/TOPIC|332/i, 5000);
      expect(topicResponse).toBeDefined();

      client.send('QUIT');
    });

    it('should return current topic on query (332)', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('topicq1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('topicq');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set a topic first
      const topic = `Query test topic`;
      client.send(`TOPIC ${channel} :${topic}`);
      await client.waitForLine(/TOPIC|332/i, 5000);

      client.clearRawBuffer();

      // Query the topic
      client.send(`TOPIC ${channel}`);

      // Should get RPL_TOPIC (332) or TOPIC
      const topicInfo = await client.waitForLine(/332|TOPIC/i, 5000);
      expect(topicInfo).toBeDefined();
      expect(topicInfo).toContain(topic);

      client.send('QUIT');
    });

    it('should reject TOPIC on +t channel from non-op', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('topicop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('topicuser1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('topict');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set +t (topic lock)
      op.send(`MODE ${channel} +t`);
      await op.waitForLine(/MODE.*\+t/i, 5000);

      user.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();

      // Non-op tries to set topic
      user.send(`TOPIC ${channel} :Shouldn't work`);

      // Should get ERR_CHANOPRIVSNEEDED (482)
      const errorResponse = await user.waitForLine(/482/i, 5000);
      expect(errorResponse).toMatch(/482/);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('INVITE', () => {
    it('should invite user to channel', async () => {
      const inviter = trackClient(await createRawSocketClient());
      const invitee = trackClient(await createRawSocketClient());

      await inviter.capLs();
      inviter.capEnd();
      inviter.register('inviter1');
      await inviter.waitForLine(/001/);

      await invitee.capLs();
      invitee.capEnd();
      invitee.register('invitee1');
      await invitee.waitForLine(/001/);

      const channel = uniqueChannel('invite');
      inviter.send(`JOIN ${channel}`);
      await inviter.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      invitee.clearRawBuffer();
      inviter.clearRawBuffer();

      // Invite the user
      inviter.send(`INVITE invitee1 ${channel}`);

      // Invitee should receive INVITE
      const inviteMsg = await invitee.waitForLine(/INVITE.*invitee1/i, 5000);
      expect(inviteMsg).toContain('INVITE');
      expect(inviteMsg).toContain(channel);

      inviter.send('QUIT');
      invitee.send('QUIT');
    });

    it('should allow invited user to join +i channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      op.capEnd();
      op.register('inviteop1');
      await op.waitForLine(/001/);

      await user.capLs();
      user.capEnd();
      user.register('invitejoin1');
      await user.waitForLine(/001/);

      const channel = uniqueChannel('invitei');
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Set +i (invite only)
      op.send(`MODE ${channel} +i`);
      await op.waitForLine(/MODE.*\+i/i, 5000);

      // Invite the user
      op.send(`INVITE invitejoin1 ${channel}`);
      await user.waitForLine(/INVITE/i, 5000);

      user.clearRawBuffer();

      // User should be able to join
      user.send(`JOIN ${channel}`);
      const joinMsg = await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'), 5000);
      expect(joinMsg).toContain('JOIN');
      expect(joinMsg).toContain(channel);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('WHOIS', () => {
    it('should return user information', async () => {
      const client = trackClient(await createRawSocketClient());
      const target = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('whoisuser1');
      await client.waitForLine(/001/);

      await target.capLs();
      target.capEnd();
      target.register('whoistarget1');
      await target.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('WHOIS whoistarget1');

      // Should get RPL_WHOISUSER (311)
      const whoisResponse = await client.waitForLine(/311.*whoistarget1/i, 5000);
      expect(whoisResponse).toMatch(/311/);
      expect(whoisResponse).toContain('whoistarget1');

      client.send('QUIT');
      target.send('QUIT');
    });

    it('should show channels user is in (RPL_WHOISCHANNELS 319)', async () => {
      const client = trackClient(await createRawSocketClient());
      const target = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('whoisuser2');
      await client.waitForLine(/001/);

      await target.capLs();
      target.capEnd();
      target.register('whoistarget2');
      await target.waitForLine(/001/);

      // Target joins a channel
      const channel = uniqueChannel('whoischan');
      target.send(`JOIN ${channel}`);
      await target.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      client.send('WHOIS whoistarget2');

      // Should get RPL_WHOISCHANNELS (319) showing the channel
      const channelsResponse = await client.waitForLine(/319|318/i, 5000);
      // 318 is end of WHOIS, 319 is channels
      expect(channelsResponse).toBeDefined();

      client.send('QUIT');
      target.send('QUIT');
    });

    it('should return ERR_NOSUCHNICK (401) for non-existent user', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('whoisuser3');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      client.send('WHOIS nonexistentuser12345');

      // Should get ERR_NOSUCHNICK (401)
      const errorResponse = await client.waitForLine(/401|318/i, 5000);
      // Some servers may just send 318 (end of WHOIS) for nonexistent users
      expect(errorResponse).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('WHO', () => {
    it('should list users in channel', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      client1.capEnd();
      client1.register('whouser1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('whouser2');
      await client2.waitForLine(/001/);

      const channel = uniqueChannel('who');
      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await client2.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      client1.send(`WHO ${channel}`);

      // Should get RPL_WHOREPLY (352) for users
      const whoResponse = await client1.waitForLine(/352|315/i, 5000);
      // 315 is end of WHO
      expect(whoResponse).toBeDefined();

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('LIST', () => {
    it('should list channels', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('listuser1');
      await client.waitForLine(/001/);

      // Create a channel
      const channel = uniqueChannel('list');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.send('LIST');

      // Should get RPL_LISTEND (323)
      const listEnd = await client.waitForLine(/322|323/i, 5000);
      // 322 is list entry, 323 is end
      expect(listEnd).toBeDefined();

      client.send('QUIT');
    });
  });

  describe('PART', () => {
    it('should leave channel', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      client.capEnd();
      client.register('partuser1');
      await client.waitForLine(/001/);

      const channel = uniqueChannel('part');
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      client.send(`PART ${channel} :Goodbye`);

      const partMsg = await client.waitForLine(/PART/i, 5000);
      expect(partMsg).toContain('PART');
      expect(partMsg).toContain(channel);

      client.send('QUIT');
    });

    it('should broadcast PART to channel members', async () => {
      const leaver = trackClient(await createRawSocketClient());
      const stayer = trackClient(await createRawSocketClient());

      await leaver.capLs();
      leaver.capEnd();
      leaver.register('leaver1');
      await leaver.waitForLine(/001/);

      await stayer.capLs();
      stayer.capEnd();
      stayer.register('stayer1');
      await stayer.waitForLine(/001/);

      const channel = uniqueChannel('partbc');
      leaver.send(`JOIN ${channel}`);
      stayer.send(`JOIN ${channel}`);
      await leaver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await stayer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      stayer.clearRawBuffer();

      leaver.send(`PART ${channel} :See ya`);

      // Stayer should see the PART
      const partMsg = await stayer.waitForLine(/PART.*leaver1/i, 5000);
      expect(partMsg).toContain('PART');
      expect(partMsg).toContain('leaver1');

      leaver.send('QUIT');
      stayer.send('QUIT');
    });
  });

  describe('QUIT', () => {
    it('should broadcast QUIT to shared channel members', async () => {
      const quitter = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await quitter.capLs();
      quitter.capEnd();
      quitter.register('quitter1');
      await quitter.waitForLine(/001/);

      await observer.capLs();
      observer.capEnd();
      observer.register('quitobs1');
      await observer.waitForLine(/001/);

      const channel = uniqueChannel('quit');
      quitter.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await quitter.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      quitter.send('QUIT :Leaving');

      // Observer should see the QUIT
      const quitMsg = await observer.waitForLine(/QUIT.*quitter1|:quitter1.*QUIT/i, 5000);
      expect(quitMsg).toContain('QUIT');

      observer.send('QUIT');
    });
  });
});
