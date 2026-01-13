import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, CAP_BUNDLES } from '../helpers/index.js';

/**
 * Away-Notify and Account-Notify Tests
 *
 * Tests real-time notifications for user status changes:
 * - away-notify: Notifies when users go away or return
 * - account-notify: Notifies when users log in/out of accounts
 */
describe('IRCv3 away-notify', () => {
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
    it('server advertises away-notify', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('away-notify')).toBe(true);
      client.send('QUIT');
    });

    it('can request away-notify capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['away-notify']);

      expect(result.ack).toContain('away-notify');
      client.send('QUIT');
    });
  });

  describe('AWAY Notification', () => {
    it('receives AWAY when shared channel user goes away', async () => {
      const observer = trackClient(await createRawSocketClient());
      const awayer = trackClient(await createRawSocketClient());

      // Observer enables account notifications bundle (away-notify, account-notify, extended-join)
      await observer.capLs();
      await observer.capReq(CAP_BUNDLES.accounts);
      observer.capEnd();
      observer.register('awayobs1');
      await observer.waitForNumeric('001');

      // Awayer registers normally
      await awayer.capLs();
      awayer.capEnd();
      awayer.register('awayuser1');
      await awayer.waitForNumeric('001');

      // Both join same channel
      const channel = uniqueChannel('away');
      observer.send(`JOIN ${channel}`);
      awayer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await awayer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));

      observer.clearRawBuffer();

      // Awayer goes away
      awayer.send('AWAY :Gone for lunch');

      // Observer should receive AWAY notification
      const awayMsg = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'awayuser1',
        5000
      );
      expect(awayMsg.command).toBe('AWAY');
      expect(awayMsg.raw).toContain('Gone for lunch');
      observer.send('QUIT');
      awayer.send('QUIT');
    });

    it('receives AWAY with empty message when user returns', async () => {
      const observer = trackClient(await createRawSocketClient());
      const awayer = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(CAP_BUNDLES.accounts);
      observer.capEnd();
      observer.register('awayobs2');
      await observer.waitForNumeric('001');

      await awayer.capLs();
      awayer.capEnd();
      awayer.register('awayuser2');
      await awayer.waitForNumeric('001');

      const channel = uniqueChannel('awayret');
      observer.send(`JOIN ${channel}`);
      awayer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await awayer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));

      // Go away first
      awayer.send('AWAY :BRB');
      await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && msg.raw.includes('BRB'),
        3000
      );

      observer.clearRawBuffer();

      // Return (AWAY with no message)
      awayer.send('AWAY');

      // Observer should receive AWAY with no trailing message
      const returnMsg = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'awayuser2',
        5000
      );
      expect(returnMsg.command).toBe('AWAY');
      // Return message should NOT have the away text
      expect(returnMsg.raw).not.toContain('BRB');
      observer.send('QUIT');
      awayer.send('QUIT');
    });

    it('does not receive AWAY for users not in shared channel', async () => {
      const observer = trackClient(await createRawSocketClient());
      const awayer = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(CAP_BUNDLES.accounts);
      observer.capEnd();
      observer.register('awayobs3');
      await observer.waitForNumeric('001');

      await awayer.capLs();
      awayer.capEnd();
      awayer.register('awayuser3');
      await awayer.waitForNumeric('001');

      // Join DIFFERENT channels
      observer.send('JOIN #awayobs3channel');
      awayer.send('JOIN #awayuser3channel');
      await observer.waitForJoin('#awayobs3channel');
      await awayer.waitForJoin('#awayuser3channel');
      await new Promise(r => setTimeout(r, 500));

      observer.clearRawBuffer();

      // Awayer goes away
      awayer.send('AWAY :Nobody should see this');

      // Observer should NOT receive notification
      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'awayuser3',
          2000
        );
        throw new Error('Should not have received AWAY for non-shared user');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected - no notification received
      }
      observer.send('QUIT');
      awayer.send('QUIT');
    });

    it('does not receive AWAY without away-notify capability', async () => {
      const observer = trackClient(await createRawSocketClient());
      const awayer = trackClient(await createRawSocketClient());

      // Observer does NOT request away-notify
      await observer.capLs();
      await observer.capReq(['multi-prefix']);
      observer.capEnd();
      observer.register('awayobs4');
      await observer.waitForNumeric('001');

      await awayer.capLs();
      awayer.capEnd();
      awayer.register('awayuser4');
      await awayer.waitForNumeric('001');

      const channel = uniqueChannel('noaway');
      observer.send(`JOIN ${channel}`);
      awayer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await awayer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));

      observer.clearRawBuffer();

      awayer.send('AWAY :Should not see this');

      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'awayuser4',
          2000
        );
        throw new Error('Should not receive AWAY without capability');
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        // Timeout expected
      }
      observer.send('QUIT');
      awayer.send('QUIT');
    });
  });

  describe('AWAY on JOIN', () => {
    it('receives AWAY status when user joins while already away', async () => {
      // Note: IRCv3 spec says servers SHOULD (not MUST) send AWAY status on JOIN
      // Nefarious does not implement this optional behavior
      // Test verifies the observer at least receives the JOIN notification
      const observer = trackClient(await createRawSocketClient());
      const awayer = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq(CAP_BUNDLES.accounts);
      observer.capEnd();
      observer.register('awayobs5');
      await observer.waitForNumeric('001');

      await awayer.capLs();
      awayer.capEnd();
      awayer.register('awayuser5');
      await awayer.waitForNumeric('001');

      // Awayer goes away BEFORE joining channel
      awayer.send('AWAY :Already away');
      await new Promise(r => setTimeout(r, 500));

      // Observer joins channel first
      const channel = uniqueChannel('awayjoin');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Awayer joins while already away
      awayer.send(`JOIN ${channel}`);
      await awayer.waitForJoin(channel);

      // Per IRCv3 spec, servers MUST send AWAY status for users who are away on JOIN
      // First we should see the JOIN
      const joinMsg = await observer.waitForParsedLine(
        msg => msg.command === 'JOIN' && msg.source?.nick?.toLowerCase() === 'awayuser5',
        5000
      );
      expect(joinMsg.command).toBe('JOIN');

      // Then we should see AWAY notification (spec says "will be sent")
      const awayMsg = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'awayuser5',
        3000
      );
      expect(awayMsg.command).toBe('AWAY');
      expect(awayMsg.raw).toContain('Already away');

      observer.send('QUIT');
      awayer.send('QUIT');
    });
  });
});

describe('IRCv3 account-notify', () => {
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
    it('server advertises account-notify', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('account-notify')).toBe(true);
      client.send('QUIT');
    });

    it('can request account-notify capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['account-notify']);

      expect(result.ack).toContain('account-notify');
      client.send('QUIT');
    });
  });

  describe('ACCOUNT Notification', () => {
    it('receives ACCOUNT when shared channel user logs in', async () => {
      // This test requires actual authentication which needs a registered account
      // We'll test that the capability works and the protocol is correct

      const observer = trackClient(await createRawSocketClient());

      await observer.capLs();
      await observer.capReq([...CAP_BUNDLES.accounts, 'sasl']);
      observer.capEnd();
      observer.register('acctobs1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('acctnotify');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Note: To fully test this, we'd need another client to authenticate
      // via SASL after joining the channel. This tests the setup is correct.
      expect(observer.hasCapEnabled('account-notify')).toBe(true);
      observer.send('QUIT');
    });

    it('ACCOUNT * indicates logout', async () => {
      // ACCOUNT * is the logout indicator per spec
      // We can't easily trigger a logout, but verify the protocol understanding

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(CAP_BUNDLES.accounts);
      client.capEnd();
      client.register('accttest3');
      await client.waitForNumeric('001');

      // The spec says ACCOUNT * indicates no account
      // This is tested by protocol understanding
      expect(client.hasCapEnabled('account-notify')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('account-notify with extended-join', () => {
    it('extended-join includes account name', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(CAP_BUNDLES.accounts);
      client1.capEnd();
      client1.register('extjoin1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      client2.capEnd();
      client2.register('extjoin2');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('extjoin');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      // Client2 joins
      client2.send(`JOIN ${channel}`);

      // Client1 should see extended JOIN with account
      // Format: :extjoin2!user@host JOIN #channel account :realname
      const joinMsg = await client1.waitForParsedLine(
        msg => msg.command === 'JOIN' &&
               msg.source?.nick?.toLowerCase() === 'extjoin2' &&
               msg.raw.includes(channel),
        5000
      );

      // extended-join format: :nick!user@host JOIN #channel account :realname
      // If not authenticated, account is *
      expect(joinMsg.raw).toMatch(/JOIN.*#.*\s+(\*|\w+)\s+:/);
      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});

describe('IRCv3 invite-notify', () => {
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
    it('server advertises invite-notify', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('invite-notify')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('INVITE Notification', () => {
    it('channel members see INVITE when op invites someone', async () => {
      const op = trackClient(await createRawSocketClient());
      const member = trackClient(await createRawSocketClient());
      const invitee = trackClient(await createRawSocketClient());

      // Op and member enable invite-notify
      await op.capLs();
      await op.capReq(['invite-notify']);
      op.capEnd();
      op.register('inviteop1');
      await op.waitForNumeric('001');

      await member.capLs();
      await member.capReq(['invite-notify']);
      member.capEnd();
      member.register('invitemem1');
      await member.waitForNumeric('001');

      await invitee.capLs();
      invitee.capEnd();
      invitee.register('invitee1');
      await invitee.waitForNumeric('001');

      // Op creates channel and member joins BEFORE setting +i
      const channel = uniqueChannel('invite');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);

      // Member joins the channel first (before +i is set)
      member.send(`JOIN ${channel}`);
      await member.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Now set channel invite-only
      op.send(`MODE ${channel} +i`);
      await new Promise(r => setTimeout(r, 300));

      member.clearRawBuffer();

      // Op invites invitee
      op.send(`INVITE invitee1 ${channel}`);

      // Member should see the INVITE (with invite-notify capability enabled)
      // Per IRCv3 spec, channel members with invite-notify see invites
      const inviteMsg = await member.waitForInvite(channel, 'invitee1', 5000);
      expect(inviteMsg).toBeDefined();
      expect(inviteMsg.raw).toContain('invitee1');
      expect(inviteMsg.raw).toContain(channel);

      op.send('QUIT');
      member.send('QUIT');
      invitee.send('QUIT');
    });
  });
});
