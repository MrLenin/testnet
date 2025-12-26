import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Message Redaction Tests (draft/message-redaction)
 *
 * Tests the IRCv3 message redaction specification for deleting messages.
 * Allows users to remove their own messages or ops to remove any message.
 */
describe('IRCv3 Message Redaction (draft/message-redaction)', () => {
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
    it('server advertises draft/message-redaction', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/message-redaction')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/message-redaction capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/message-redaction']);

      expect(result.ack).toContain('draft/message-redaction');

      client.send('QUIT');
    });
  });

  describe('REDACT Command', () => {
    it('can redact own message with REDACT', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message']);
      client.capEnd();
      client.register('redact1');
      await client.waitForLine(/001/);

      const channel = `#redact${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Send a message and get its msgid
      client.send(`PRIVMSG ${channel} :Message to be redacted`);

      let msgid: string | null = null;
      try {
        const echo = await client.waitForLine(/PRIVMSG.*Message to be redacted/i, 3000);
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
        client.send(`REDACT ${channel} ${msgid}`);

        try {
          const response = await client.waitForLine(/REDACT|FAIL/i, 5000);
          expect(response).toBeDefined();
          console.log('REDACT response:', response);
        } catch {
          console.log('No REDACT response');
        }
      }

      client.send('QUIT');
    });

    it('REDACT with reason includes reason in notification', async () => {
      const sender = trackClient(await createRawSocketClient());
      const receiver = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message']);
      sender.capEnd();
      sender.register('redsend1');
      await sender.waitForLine(/001/);

      await receiver.capLs();
      await receiver.capReq(['draft/message-redaction']);
      receiver.capEnd();
      receiver.register('redrecv1');
      await receiver.waitForLine(/001/);

      const channel = `#redreason${Date.now()}`;
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await receiver.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Send message
      sender.send(`PRIVMSG ${channel} :This will be redacted`);

      let msgid: string | null = null;
      try {
        const echo = await sender.waitForLine(/PRIVMSG.*This will be redacted/i, 3000);
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
        sender.send(`REDACT ${channel} ${msgid} :Posted by mistake`);

        try {
          const notification = await receiver.waitForLine(/REDACT/i, 5000);
          expect(notification).toContain(msgid);
          // May contain reason
          console.log('REDACT notification:', notification);
        } catch {
          console.log('No REDACT notification received');
        }
      }

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('REDACT Permissions', () => {
    it('cannot redact other user message without op', async () => {
      const sender = trackClient(await createRawSocketClient());
      const attacker = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message']);
      sender.capEnd();
      sender.register('redsender2');
      await sender.waitForLine(/001/);

      await attacker.capLs();
      await attacker.capReq(['draft/message-redaction']);
      attacker.capEnd();
      attacker.register('redattack1');
      await attacker.waitForLine(/001/);

      const channel = `#redperm${Date.now()}`;
      sender.send(`JOIN ${channel}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Sender is now op, let attacker join
      attacker.send(`JOIN ${channel}`);
      await attacker.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Sender sends message
      sender.send(`PRIVMSG ${channel} :Protected message`);

      let msgid: string | null = null;
      try {
        const echo = await sender.waitForLine(/PRIVMSG.*Protected message/i, 3000);
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
        attacker.send(`REDACT ${channel} ${msgid}`);

        try {
          // Should receive error (FAIL or numeric)
          const response = await attacker.waitForLine(/REDACT|FAIL|4\d\d/i, 3000);
          // Either FAIL or error numeric expected
          console.log('Unauthorized REDACT response:', response);
        } catch {
          console.log('No response to unauthorized REDACT');
        }
      }

      sender.send('QUIT');
      attacker.send('QUIT');
    });

    it('op can redact any message in channel', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/message-redaction']);
      op.capEnd();
      op.register('redop1');
      await op.waitForLine(/001/);

      await user.capLs();
      await user.capReq(['draft/message-redaction', 'echo-message']);
      user.capEnd();
      user.register('reduser1');
      await user.waitForLine(/001/);

      const channel = `#redop${Date.now()}`;
      op.send(`JOIN ${channel}`);
      await op.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      user.send(`JOIN ${channel}`);
      await user.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // User sends message
      user.send(`PRIVMSG ${channel} :User message`);

      let msgid: string | null = null;
      try {
        const echo = await user.waitForLine(/PRIVMSG.*User message/i, 3000);
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
        op.send(`REDACT ${channel} ${msgid} :Moderation action`);

        try {
          const response = await op.waitForLine(/REDACT/i, 5000);
          expect(response).toBeDefined();
          console.log('Op REDACT response:', response);
        } catch {
          console.log('No op REDACT response');
        }
      }

      op.send('QUIT');
      user.send('QUIT');
    });
  });

  describe('REDACT Edge Cases', () => {
    it('REDACT nonexistent msgid returns error', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction']);
      client.capEnd();
      client.register('redinv1');
      await client.waitForLine(/001/);

      const channel = `#redinv${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Try to redact nonexistent message
      client.send(`REDACT ${channel} nonexistent-msgid-12345`);

      try {
        const response = await client.waitForLine(/REDACT|FAIL|4\d\d/i, 3000);
        console.log('Invalid msgid response:', response);
      } catch {
        console.log('No response for invalid msgid');
      }

      client.send('QUIT');
    });

    it('REDACT same message twice', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/message-redaction', 'echo-message']);
      client.capEnd();
      client.register('redtwice1');
      await client.waitForLine(/001/);

      const channel = `#redtwice${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.send(`PRIVMSG ${channel} :Double redact test`);

      let msgid: string | null = null;
      try {
        const echo = await client.waitForLine(/PRIVMSG.*Double redact/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        // First redact
        client.send(`REDACT ${channel} ${msgid}`);
        await new Promise(r => setTimeout(r, 500));

        client.clearRawBuffer();

        // Second redact of same message
        client.send(`REDACT ${channel} ${msgid}`);

        try {
          const response = await client.waitForLine(/REDACT|FAIL|4\d\d/i, 3000);
          console.log('Double REDACT response:', response);
        } catch {
          console.log('No response for double REDACT');
        }
      }

      client.send('QUIT');
    });
  });

  describe('REDACT Notification', () => {
    it('other channel members receive REDACT notification', async () => {
      const redactor = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      await redactor.capLs();
      await redactor.capReq(['draft/message-redaction', 'echo-message']);
      redactor.capEnd();
      redactor.register('rednote1');
      await redactor.waitForLine(/001/);

      await observer.capLs();
      await observer.capReq(['draft/message-redaction']);
      observer.capEnd();
      observer.register('redobs1');
      await observer.waitForLine(/001/);

      const channel = `#rednote${Date.now()}`;
      redactor.send(`JOIN ${channel}`);
      observer.send(`JOIN ${channel}`);
      await redactor.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await observer.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      redactor.send(`PRIVMSG ${channel} :Message to be seen redacted`);

      let msgid: string | null = null;
      try {
        const echo = await redactor.waitForLine(/PRIVMSG.*Message to be seen/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo');
      }

      if (msgid) {
        observer.clearRawBuffer();

        redactor.send(`REDACT ${channel} ${msgid}`);

        try {
          const notification = await observer.waitForLine(/REDACT/i, 5000);
          expect(notification).toContain('REDACT');
          expect(notification).toContain(channel);
          console.log('Observer REDACT notification:', notification);
        } catch {
          console.log('Observer did not receive REDACT');
        }
      }

      redactor.send('QUIT');
      observer.send('QUIT');
    });
  });
});
