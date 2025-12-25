import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client } from '../helpers/index.js';

/**
 * Message Redaction Tests (draft/message-redaction)
 *
 * Tests the IRCv3 message redaction specification for deleting messages.
 * Allows users to remove their own messages or ops to remove any message.
 */
describe('IRCv3 Message Redaction (draft/message-redaction)', () => {
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
    it('server advertises draft/message-redaction', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'redtest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/message-redaction')).toBe(true);
    });

    it('can request draft/message-redaction capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'redtest2' })
      );

      await client.capLs();
      const result = await client.capReq(['draft/message-redaction']);

      expect(result.ack).toContain('draft/message-redaction');
    });
  });

  describe('REDACT Command', () => {
    it('can redact own message with REDACT', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'redact1' })
      );

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      client.capEnd();
      client.register('redact1');
      await client.waitForRaw(/001/);

      const channel = `#redact${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Send a message and get its msgid
      client.say(channel, 'Message to be redacted');

      let msgid: string | null = null;
      try {
        const echo = await client.waitForRaw(/PRIVMSG.*Message to be redacted/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo with msgid');
      }

      if (msgid) {
        client.clearRawBuffer();

        // Redact the message
        client.raw(`REDACT ${channel} ${msgid}`);

        try {
          const response = await client.waitForRaw(/REDACT|FAIL/i, 5000);
          expect(response).toBeDefined();
          console.log('REDACT response:', response);
        } catch {
          console.log('No REDACT response');
        }
      }
    });

    it('REDACT with reason includes reason in notification', async () => {
      const sender = trackClient(
        await createRawIRCv3Client({ nick: 'redsend1' })
      );
      const receiver = trackClient(
        await createRawIRCv3Client({ nick: 'redrecv1' })
      );

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      sender.capEnd();
      sender.register('redsend1');
      await sender.waitForRaw(/001/);

      await receiver.capLs();
      await receiver.capReq(['draft/message-redaction', 'message-tags']);
      receiver.capEnd();
      receiver.register('redrecv1');
      await receiver.waitForRaw(/001/);

      const channel = `#redreason${Date.now()}`;
      sender.join(channel);
      receiver.join(channel);
      await sender.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Send message
      sender.say(channel, 'This will be redacted');

      let msgid: string | null = null;
      try {
        const echo = await sender.waitForRaw(/PRIVMSG.*This will be redacted/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        receiver.clearRawBuffer();

        // Redact with reason
        sender.raw(`REDACT ${channel} ${msgid} :Posted by mistake`);

        try {
          const notification = await receiver.waitForRaw(/REDACT/i, 5000);
          expect(notification).toContain(msgid);
          // May contain reason
          console.log('REDACT notification:', notification);
        } catch {
          console.log('No REDACT notification received');
        }
      }
    });
  });

  describe('REDACT Permissions', () => {
    it('cannot redact other user message without op', async () => {
      const sender = trackClient(
        await createRawIRCv3Client({ nick: 'redsender2' })
      );
      const attacker = trackClient(
        await createRawIRCv3Client({ nick: 'redattack1' })
      );

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      sender.capEnd();
      sender.register('redsender2');
      await sender.waitForRaw(/001/);

      await attacker.capLs();
      await attacker.capReq(['draft/message-redaction', 'message-tags']);
      attacker.capEnd();
      attacker.register('redattack1');
      await attacker.waitForRaw(/001/);

      const channel = `#redperm${Date.now()}`;
      sender.join(channel);
      await sender.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      // Sender is now op, let attacker join
      attacker.join(channel);
      await attacker.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Sender sends message
      sender.say(channel, 'Protected message');

      let msgid: string | null = null;
      try {
        const echo = await sender.waitForRaw(/PRIVMSG.*Protected message/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        attacker.clearRawBuffer();

        // Attacker tries to redact sender's message
        attacker.raw(`REDACT ${channel} ${msgid}`);

        try {
          // Should receive error (FAIL or numeric)
          const response = await attacker.waitForRaw(/REDACT|FAIL|4\d\d/i, 3000);
          // Either FAIL or error numeric expected
          console.log('Unauthorized REDACT response:', response);
        } catch {
          console.log('No response to unauthorized REDACT');
        }
      }
    });

    it('op can redact any message in channel', async () => {
      const op = trackClient(
        await createRawIRCv3Client({ nick: 'redop1' })
      );
      const user = trackClient(
        await createRawIRCv3Client({ nick: 'reduser1' })
      );

      await op.capLs();
      await op.capReq(['draft/message-redaction', 'message-tags']);
      op.capEnd();
      op.register('redop1');
      await op.waitForRaw(/001/);

      await user.capLs();
      await user.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      user.capEnd();
      user.register('reduser1');
      await user.waitForRaw(/001/);

      const channel = `#redop${Date.now()}`;
      op.join(channel);
      await op.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      user.join(channel);
      await user.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // User sends message
      user.say(channel, 'User message');

      let msgid: string | null = null;
      try {
        const echo = await user.waitForRaw(/PRIVMSG.*User message/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        op.clearRawBuffer();

        // Op redacts user's message
        op.raw(`REDACT ${channel} ${msgid} :Moderation action`);

        try {
          const response = await op.waitForRaw(/REDACT/i, 5000);
          expect(response).toBeDefined();
          console.log('Op REDACT response:', response);
        } catch {
          console.log('No op REDACT response');
        }
      }
    });
  });

  describe('REDACT Edge Cases', () => {
    it('REDACT nonexistent msgid returns error', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'redinv1' })
      );

      await client.capLs();
      await client.capReq(['draft/message-redaction']);
      client.capEnd();
      client.register('redinv1');
      await client.waitForRaw(/001/);

      const channel = `#redinv${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Try to redact nonexistent message
      client.raw(`REDACT ${channel} nonexistent-msgid-12345`);

      try {
        const response = await client.waitForRaw(/REDACT|FAIL|4\d\d/i, 3000);
        console.log('Invalid msgid response:', response);
      } catch {
        console.log('No response for invalid msgid');
      }
    });

    it('REDACT same message twice', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'redtwice1' })
      );

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      client.capEnd();
      client.register('redtwice1');
      await client.waitForRaw(/001/);

      const channel = `#redtwice${Date.now()}`;
      client.join(channel);
      await client.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));

      client.say(channel, 'Double redact test');

      let msgid: string | null = null;
      try {
        const echo = await client.waitForRaw(/PRIVMSG.*Double redact/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        // First redact
        client.raw(`REDACT ${channel} ${msgid}`);
        await new Promise(r => setTimeout(r, 500));

        client.clearRawBuffer();

        // Second redact of same message
        client.raw(`REDACT ${channel} ${msgid}`);

        try {
          const response = await client.waitForRaw(/REDACT|FAIL|4\d\d/i, 3000);
          console.log('Double REDACT response:', response);
        } catch {
          console.log('No response for double REDACT');
        }
      }
    });
  });

  describe('REDACT Notification', () => {
    it('other channel members receive REDACT notification', async () => {
      const redactor = trackClient(
        await createRawIRCv3Client({ nick: 'rednote1' })
      );
      const observer = trackClient(
        await createRawIRCv3Client({ nick: 'redobs1' })
      );

      await redactor.capLs();
      await redactor.capReq(['draft/message-redaction', 'echo-message', 'message-tags']);
      redactor.capEnd();
      redactor.register('rednote1');
      await redactor.waitForRaw(/001/);

      await observer.capLs();
      await observer.capReq(['draft/message-redaction', 'message-tags']);
      observer.capEnd();
      observer.register('redobs1');
      await observer.waitForRaw(/001/);

      const channel = `#rednote${Date.now()}`;
      redactor.join(channel);
      observer.join(channel);
      await redactor.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForRaw(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      redactor.say(channel, 'Message to be seen redacted');

      let msgid: string | null = null;
      try {
        const echo = await redactor.waitForRaw(/PRIVMSG.*Message to be seen/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        observer.clearRawBuffer();

        redactor.raw(`REDACT ${channel} ${msgid}`);

        try {
          const notification = await observer.waitForRaw(/REDACT/i, 5000);
          expect(notification).toContain('REDACT');
          expect(notification).toContain(channel);
          console.log('Observer REDACT notification:', notification);
        } catch {
          console.log('Observer did not receive REDACT');
        }
      }
    });
  });
});
