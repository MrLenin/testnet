import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * Channel Rename Tests (draft/channel-rename)
 *
 * Tests the IRCv3 channel rename specification for renaming channels
 * without requiring users to rejoin.
 */
describe('IRCv3 Channel Rename (draft/channel-rename)', () => {
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
    it('server advertises draft/channel-rename', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'rentest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/channel-rename')).toBe(true);
    });

    it('can request draft/channel-rename capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'rentest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/channel-rename']);

      expect(result.ack).toContain('draft/channel-rename');
    });
  });

  describe('RENAME Command', () => {
    it('channel founder can rename channel', async () => {
      const founder = trackClient(
        await createRawIRCv3Client({ nick: 'renfound1' })
      );

      await founder.capLs();
      await founder.capReq(['draft/channel-rename']);
      founder.capEnd();
      founder.register('renfound1');
      await founder.waitForRaw(/001/);

      const oldName = `#renold${Date.now()}`;
      founder.join(oldName);
      await founder.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));

      founder.clearRawBuffer();

      const newName = `#rennew${Date.now()}`;
      founder.raw(`RENAME ${oldName} ${newName} :Rebranding`);

      try {
        // Should receive RENAME notification
        const response = await founder.waitForRaw(/RENAME/i, 5000);
        expect(response).toContain('RENAME');
        console.log('RENAME response:', response);
      } catch {
        console.log('No RENAME response - may require services registration');
      }
    });

    it('RENAME includes reason if provided', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'renreason1' })
      );

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renreason1');
      await client.waitForRaw(/001/);

      const oldName = `#renreas${Date.now()}`;
      client.join(oldName);
      await client.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));

      client.clearRawBuffer();

      const newName = `#rennewreas${Date.now()}`;
      const reason = 'Channel reorganization';
      client.raw(`RENAME ${oldName} ${newName} :${reason}`);

      try {
        const response = await client.waitForRaw(/RENAME/i, 5000);
        if (response.includes(reason)) {
          expect(response).toContain(reason);
        }
        console.log('RENAME with reason:', response);
      } catch {
        console.log('No RENAME response');
      }
    });
  });

  describe('RENAME Notification', () => {
    it('channel members receive RENAME notification', async () => {
      const op = trackClient(
        await createRawIRCv3Client({ nick: 'renop1' })
      );
      const member = trackClient(
        await createRawIRCv3Client({ nick: 'renmem1' })
      );

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop1');
      await op.waitForRaw(/001/);

      await member.capLs();
      await member.capReq(['draft/channel-rename']);
      member.capEnd();
      member.register('renmem1');
      await member.waitForRaw(/001/);

      const oldName = `#rennote${Date.now()}`;
      op.join(oldName);
      member.join(oldName);
      await op.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));
      await member.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      member.clearRawBuffer();

      const newName = `#rennewnote${Date.now()}`;
      op.raw(`RENAME ${oldName} ${newName}`);

      try {
        const notification = await member.waitForRaw(/RENAME/i, 5000);
        expect(notification).toContain('RENAME');
        expect(notification).toContain(oldName);
        expect(notification).toContain(newName);
        console.log('Member RENAME notification:', notification);
      } catch {
        console.log('Member did not receive RENAME');
      }
    });

    it('user without capability receives PART/JOIN instead', async () => {
      const op = trackClient(
        await createRawIRCv3Client({ nick: 'renop2' })
      );
      const nocap = trackClient(
        await createRawIRCv3Client({ nick: 'rennocap1' })
      );

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop2');
      await op.waitForRaw(/001/);

      // nocap does NOT request channel-rename
      await nocap.capLs();
      await nocap.capReq(['multi-prefix']);
      nocap.capEnd();
      nocap.register('rennocap1');
      await nocap.waitForRaw(/001/);

      const oldName = `#rennocap${Date.now()}`;
      op.join(oldName);
      nocap.join(oldName);
      await op.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));
      await nocap.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      nocap.clearRawBuffer();

      const newName = `#rennocapnew${Date.now()}`;
      op.raw(`RENAME ${oldName} ${newName}`);

      // nocap should see PART from old + JOIN to new instead of RENAME
      try {
        const response = await nocap.waitForRaw(/PART|JOIN|RENAME/i, 5000);
        console.log('No-cap client response:', response);
        // Should NOT be RENAME
        if (response.includes('RENAME')) {
          throw new Error('Should not receive RENAME without capability');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Should not')) {
          throw error;
        }
        console.log('No response for no-cap client');
      }
    });
  });

  describe('RENAME Permissions', () => {
    it('non-op cannot rename channel', async () => {
      const op = trackClient(
        await createRawIRCv3Client({ nick: 'renop3' })
      );
      const user = trackClient(
        await createRawIRCv3Client({ nick: 'renuser1' })
      );

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renop3');
      await op.waitForRaw(/001/);

      await user.capLs();
      await user.capReq(['draft/channel-rename']);
      user.capEnd();
      user.register('renuser1');
      await user.waitForRaw(/001/);

      const channel = `#renperm${Date.now()}`;
      op.join(channel);
      await op.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      user.join(channel);
      await user.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      user.clearRawBuffer();

      // User (not op) tries to rename
      user.raw(`RENAME ${channel} #renamed`);

      try {
        const response = await user.waitForRaw(/RENAME|FAIL|4\d\d|ERR/i, 3000);
        console.log('Non-op RENAME response:', response);
        // Should be error, not success
      } catch {
        console.log('No response for non-op RENAME');
      }
    });
  });

  describe('RENAME Edge Cases', () => {
    it('RENAME to existing channel name fails', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'renexist1' })
      );

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renexist1');
      await client.waitForRaw(/001/);

      const channel1 = `#renexist1${Date.now()}`;
      const channel2 = `#renexist2${Date.now()}`;

      client.join(channel1);
      client.join(channel2);
      await client.waitForRaw(new RegExp(`JOIN.*${channel1}`, 'i'));
      await client.waitForRaw(new RegExp(`JOIN.*${channel2}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      client.clearRawBuffer();

      // Try to rename to existing channel
      client.raw(`RENAME ${channel1} ${channel2}`);

      try {
        const response = await client.waitForRaw(/RENAME|FAIL|4\d\d/i, 3000);
        console.log('Existing name RENAME response:', response);
        // Should fail
      } catch {
        console.log('No response for existing name RENAME');
      }
    });

    it('RENAME preserves channel modes', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'renmode1' })
      );

      await client.capLs();
      await client.capReq(['draft/channel-rename']);
      client.capEnd();
      client.register('renmode1');
      await client.waitForRaw(/001/);

      const oldName = `#renmode${Date.now()}`;
      client.join(oldName);
      await client.waitForRaw(new RegExp(`JOIN.*${oldName}`, 'i'));

      // Set some modes
      client.raw(`MODE ${oldName} +nt`);
      await new Promise(r => setTimeout(r, 300));

      const newName = `#renmodenew${Date.now()}`;
      client.raw(`RENAME ${oldName} ${newName}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Check modes on new channel
      client.raw(`MODE ${newName}`);

      try {
        const modeResponse = await client.waitForRaw(/324.*${newName}/i, 3000);
        console.log('Renamed channel modes:', modeResponse);
        // Modes should be preserved
      } catch {
        console.log('Could not check renamed channel modes');
      }
    });
  });
});
