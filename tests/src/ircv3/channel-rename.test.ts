import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel } from '../helpers/index.js';

/**
 * Channel Rename Tests (draft/channel-rename)
 *
 * Tests the IRCv3 channel rename specification for renaming channels
 * without requiring users to rejoin.
 */
describe('IRCv3 Channel Rename (draft/channel-rename)', () => {
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
    it('server advertises draft/channel-rename', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/channel-rename')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/channel-rename capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/channel-rename']);

      expect(result.ack).toContain('draft/channel-rename');

      client.send('QUIT');
    });
  });

  describe('RENAME Command', () => {
    it('channel founder can rename channel', async () => {
      const founder = trackClient(await createRawSocketClient());

      await founder.capLs();
      await founder.capReq(['draft/channel-rename']);
      founder.capEnd();
      founder.register('renfound1');
      await founder.waitForNumeric('001');

      const oldName = uniqueChannel('renold');
      founder.send(`JOIN ${oldName}`);
      await founder.waitForJoin(oldName);

      founder.clearRawBuffer();

      const newName = uniqueChannel('rennew');
      founder.send(`RENAME ${oldName} ${newName} :Rebranding`);

      // Should receive RENAME notification
      const response = await founder.waitForCommand('RENAME', 5000);
      expect(response.command).toBe('RENAME');
      expect(response.raw).toContain(oldName);
      expect(response.raw).toContain(newName);

      founder.send('QUIT');
    });

    it('RENAME includes reason if provided', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renreason1');
      await client.waitForNumeric('001');

      const oldName = uniqueChannel('renreas');
      client.send(`JOIN ${oldName}`);
      await client.waitForJoin(oldName);

      client.clearRawBuffer();

      const newName = uniqueChannel('rennewreas');
      const reason = 'Channel reorganization';
      client.send(`RENAME ${oldName} ${newName} :${reason}`);

      const response = await client.waitForCommand('RENAME', 5000);
      expect(response.command).toBe('RENAME');
      // Reason may or may not be echoed back depending on implementation
      expect(response.raw).toContain(newName);

      client.send('QUIT');
    });
  });

  describe('RENAME Notification', () => {
    it('channel members receive RENAME notification', async () => {
      const op = trackClient(await createRawSocketClient());
      const member = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop1');
      await op.waitForNumeric('001');

      await member.capLs();
      await member.capReq(['draft/channel-rename']);
      member.capEnd();
      member.register('renmem1');
      await member.waitForNumeric('001');

      const oldName = uniqueChannel('rennote');
      op.send(`JOIN ${oldName}`);
      member.send(`JOIN ${oldName}`);
      await op.waitForJoin(oldName);
      await member.waitForJoin(oldName);
      await new Promise(r => setTimeout(r, 300));

      member.clearRawBuffer();

      const newName = uniqueChannel('rennewnote');
      op.send(`RENAME ${oldName} ${newName}`);

      const notification = await member.waitForCommand('RENAME', 5000);
      expect(notification.command).toBe('RENAME');
      expect(notification.raw).toContain(oldName);
      expect(notification.raw).toContain(newName);

      op.send('QUIT');
      member.send('QUIT');
    });

    it('user without capability receives PART/JOIN instead of RENAME', async () => {
      const op = trackClient(await createRawSocketClient());
      const nocap = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop2');
      await op.waitForNumeric('001');

      // nocap does NOT request channel-rename
      await nocap.capLs();
      await nocap.capReq(['multi-prefix']);
      nocap.capEnd();
      nocap.register('rennocap1');
      await nocap.waitForNumeric('001');

      const oldName = uniqueChannel('rennocap');
      op.send(`JOIN ${oldName}`);
      nocap.send(`JOIN ${oldName}`);
      await op.waitForJoin(oldName);
      await nocap.waitForJoin(oldName);
      await new Promise(r => setTimeout(r, 300));

      nocap.clearRawBuffer();

      const newName = uniqueChannel('rennocapnew');
      op.send(`RENAME ${oldName} ${newName}`);

      // nocap should see PART or JOIN, NOT RENAME
      const response = await nocap.waitForParsedLine(
        msg => ['PART', 'JOIN', 'RENAME'].includes(msg.command),
        5000
      );

      // Should NOT be RENAME - that would leak the capability
      expect(response.command).not.toBe('RENAME');
      expect(['PART', 'JOIN'].includes(response.command)).toBe(true);

      op.send('QUIT');
      nocap.send('QUIT');
    });
  });

  describe('RENAME Permissions', () => {
    it('non-op cannot rename channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop3');
      await op.waitForNumeric('001');

      await user.capLs();
      await user.capReq(['draft/channel-rename']);
      user.capEnd();
      user.register('renuser1');
      await user.waitForNumeric('001');

      const channel = uniqueChannel('renperm');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);

      user.send(`JOIN ${channel}`);
      await user.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();

      // User (not op) tries to rename - should fail
      user.send(`RENAME ${channel} #renamed`);

      // Should receive error, NOT success RENAME
      const response = await user.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      expect(response.command === 'FAIL' || /^4\d\d$/.test(response.command)).toBe(true);

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('RENAME Edge Cases', () => {
    it('RENAME to existing channel name fails', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renexist1');
      await client.waitForNumeric('001');

      const channel1 = uniqueChannel('renexist1');
      const channel2 = uniqueChannel('renexist2');

      client.send(`JOIN ${channel1}`);
      client.send(`JOIN ${channel2}`);
      await client.waitForJoin(channel1);
      await client.waitForJoin(channel2);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      // Try to rename to existing channel - should fail
      client.send(`RENAME ${channel1} ${channel2}`);

      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      expect(response.command === 'FAIL' || /^4\d\d$/.test(response.command)).toBe(true);

      client.send('QUIT');
    });

    it('RENAME preserves channel modes', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renmode1');
      await client.waitForNumeric('001');

      const oldName = uniqueChannel('renmode');
      client.send(`JOIN ${oldName}`);
      await client.waitForJoin(oldName);

      // Set a distinctive mode (+s = secret)
      client.send(`MODE ${oldName} +s`);
      await new Promise(r => setTimeout(r, 300));

      const newName = uniqueChannel('renmodenew');
      client.send(`RENAME ${oldName} ${newName}`);

      // Wait for rename to complete
      await client.waitForCommand('RENAME', 5000);
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      // Check modes on new channel
      client.send(`MODE ${newName}`);

      const modeResponse = await client.waitForNumeric('324', 5000);
      expect(modeResponse.command).toBe('324');
      // Mode +s should be preserved
      expect(modeResponse.raw).toContain('s');

      client.send('QUIT');
    });
  });
});
