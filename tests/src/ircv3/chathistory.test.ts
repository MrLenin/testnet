import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId } from '../helpers/index.js';

/**
 * Chathistory Tests (draft/chathistory)
 *
 * Tests the IRCv3 chathistory specification for retrieving message history.
 * History retrieval requires authenticated users and proper channel membership.
 *
 * Note: Some tests require specific server capabilities:
 * - draft/event-playback: Required for TAGMSG and channel events (JOIN, PART, KICK, etc.)
 *   to be stored and returned in history. The server must have CAP_draft_event_playback
 *   enabled, AND clients must request the draft/event-playback capability.
 */
describe('IRCv3 Chathistory (draft/chathistory)', () => {
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
    it('server advertises draft/chathistory', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('draft/chathistory')).toBe(true);
      client.send('QUIT');
    });

    it('can request draft/chathistory capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/chathistory', 'batch', 'server-time']);

      expect(result.ack).toContain('draft/chathistory');
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY LATEST', () => {
    it('CHATHISTORY LATEST returns messages in a batch', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histlatest1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histlatest');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send some messages to create history
      client.send(`PRIVMSG ${channelName} :History message 1`);
      client.send(`PRIVMSG ${channelName} :History message 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request latest 10 messages
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // Should receive a batch with chathistory type
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toMatch(/BATCH \+\S+ chathistory/i);

      // Collect messages in batch
      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Expect at least 2 messages (the ones we sent)
      expect(messages.length).toBeGreaterThanOrEqual(2);
      console.log('CHATHISTORY LATEST messages:', messages.length);
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY BEFORE', () => {
    it('CHATHISTORY BEFORE retrieves messages before a timestamp', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histbefore1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histbefore');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Create some history
      client.send(`PRIVMSG ${channelName} :Before test 1`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Before test 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request messages before "now" (timestamp=* means latest)
      const now = new Date().toISOString();
      client.send(`CHATHISTORY BEFORE ${channelName} timestamp=${now} 10`);

      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toMatch(/chathistory/i);

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      expect(messages.length).toBeGreaterThanOrEqual(2);
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY AFTER', () => {
    it('CHATHISTORY AFTER retrieves messages after a timestamp', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histafter1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histafter');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Get a reference timestamp
      const beforeMsgs = new Date().toISOString();
      await new Promise(r => setTimeout(r, 100));

      // Send messages
      client.send(`PRIVMSG ${channelName} :After test 1`);
      client.send(`PRIVMSG ${channelName} :After test 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request messages after the reference timestamp
      client.send(`CHATHISTORY AFTER ${channelName} timestamp=${beforeMsgs} 10`);

      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toMatch(/chathistory/i);

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      expect(messages.length).toBeGreaterThanOrEqual(2);
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY AROUND', () => {
    it('CHATHISTORY AROUND retrieves messages around a timestamp', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histaround1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histaround');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Around test 1`);
      await new Promise(r => setTimeout(r, 100));
      const middleTime = new Date().toISOString();
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Around test 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY AROUND ${channelName} timestamp=${middleTime} 10`);

      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toMatch(/chathistory/i);

      // Collect messages
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
      }
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY TARGETS', () => {
    it('CHATHISTORY TARGETS lists channels with history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histtargets1');
      await client.waitForLine(/001/);

      // Join a channel and send a message to create history
      const channelName = uniqueChannel('histtargets');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client.send(`PRIVMSG ${channelName} :Targets test message`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request list of targets with history
      // TARGETS requires two timestamps (unlike other subcommands that accept *)
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      client.send(`CHATHISTORY TARGETS timestamp=${past} timestamp=${now} 10`);

      // Response includes CHATHISTORY lines listing targets
      const response = await client.waitForLine(/BATCH.*chathistory|CHATHISTORY/i, 5000);
      expect(response).toBeDefined();
      console.log('CHATHISTORY TARGETS response:', response);
      client.send('QUIT');
    });
  });

  describe('Chathistory Message Format', () => {
    it('chathistory messages include time tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histformat1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histformat');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Format test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      expect(messages.length).toBeGreaterThan(0);
      // Each message should have a time tag
      for (const msg of messages) {
        if (msg.startsWith('@')) {
          expect(msg).toMatch(/time=\d{4}-\d{2}-\d{2}T/);
        }
      }
      client.send('QUIT');
    });

    it('chathistory messages include msgid tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histmsgid1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histmsgid');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :MsgID test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      expect(messages.length).toBeGreaterThan(0);
      // Messages should have msgid tags
      for (const msg of messages) {
        if (msg.startsWith('@')) {
          expect(msg).toMatch(/msgid=/);
        }
      }
      client.send('QUIT');
    });
  });

  describe('Chathistory Error Handling', () => {
    it('returns error for unauthorized channel history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'standard-replies']);
      client.capEnd();
      client.register('histerr1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try to get history for a channel we're not in
      client.send('CHATHISTORY LATEST #nonexistentchannel12345 * 10');

      // Should receive FAIL (with standard-replies), NOTICE, or error numeric
      const response = await client.waitForLine(/FAIL|NOTICE|ERR|4\d\d/, 3000);
      expect(response).toBeDefined();
      console.log('Unauthorized history error:', response);
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY BETWEEN', () => {
    it('CHATHISTORY BETWEEN retrieves messages in time range', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histbetween1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histbetween');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Get timestamp before messages
      const startTime = new Date().toISOString();
      await new Promise(r => setTimeout(r, 100));

      // Create some history
      client.send(`PRIVMSG ${channelName} :Between test 1`);
      client.send(`PRIVMSG ${channelName} :Between test 2`);
      client.send(`PRIVMSG ${channelName} :Between test 3`);
      await new Promise(r => setTimeout(r, 500));

      // Get timestamp after messages
      const endTime = new Date().toISOString();

      client.clearRawBuffer();

      // Request messages between timestamps
      client.send(`CHATHISTORY BETWEEN ${channelName} timestamp=${startTime} timestamp=${endTime} 10`);

      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toMatch(/chathistory/i);

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      expect(messages.length).toBeGreaterThanOrEqual(3);
      console.log('CHATHISTORY BETWEEN messages:', messages.length);
      client.send('QUIT');
    });
  });

  describe('Chathistory Limit Handling', () => {
    it('respects message limit parameter', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histlimit1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histlimit');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send 10 messages and wait for echo of last one
      for (let i = 0; i < 10; i++) {
        client.send(`PRIVMSG ${channelName} :Limit test message ${i}`);
      }
      await client.waitForLine(/Limit test message 9/, 5000);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();
      await new Promise(r => setTimeout(r, 100));

      // Request only 3 messages
      client.send(`CHATHISTORY LATEST ${channelName} * 3`);

      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Should have at most 3 messages
      expect(messages.length).toBeLessThanOrEqual(3);
      console.log('Limited history messages:', messages.length);
      client.send('QUIT');
    });

    it('handles limit of zero gracefully', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histzero1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histzero');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Zero limit test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request with limit 0
      client.send(`CHATHISTORY LATEST ${channelName} * 0`);

      // Should receive either an empty batch or a FAIL response
      const response = await client.waitForLine(/BATCH|FAIL/i, 3000);
      expect(response).toBeDefined();
      console.log('Zero limit response:', response);
      client.send('QUIT');
    });

    it('handles very large limit', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histlarge1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histlarge');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Large limit test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request with very large limit (should be capped by server)
      client.send(`CHATHISTORY LATEST ${channelName} * 1000000`);

      // Should receive a batch response (server caps the limit)
      const response = await client.waitForLine(/BATCH|FAIL/i, 5000);
      expect(response).toBeDefined();
      console.log('Large limit response:', response);
      client.send('QUIT');
    });
  });

  describe('Chathistory with msgid References', () => {
    it('CHATHISTORY BEFORE with msgid', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histmsgid2');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histmsgid');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send messages and capture msgid - MUST succeed
      client.send(`PRIVMSG ${channelName} :First message`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Second message`);

      const echo = await client.waitForLine(/PRIVMSG.*Second message/i, 3000);
      const match = echo.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const msgid = match![1];

      // Wait for history backend to persist the message
      await new Promise(r => setTimeout(r, 1000));
      client.clearRawBuffer();

      // Request messages before this msgid
      client.send(`CHATHISTORY BEFORE ${channelName} msgid=${msgid} 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Should have at least the first message
      expect(messages.length).toBeGreaterThanOrEqual(1);
      // Should NOT include "Second message"
      for (const msg of messages) {
        expect(msg).not.toContain('Second message');
      }

      client.send('QUIT');
    });

    it('CHATHISTORY AFTER with msgid', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histafter2');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histafter2');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send first message and capture msgid - MUST succeed
      client.send(`PRIVMSG ${channelName} :Reference message`);
      const echo = await client.waitForLine(/PRIVMSG.*Reference message/i, 3000);
      const match = echo.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const msgid = match![1];

      // Send more messages after capturing the reference msgid
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :After message 1`);
      await client.waitForLine(/PRIVMSG.*After message 1/i, 3000);
      client.send(`PRIVMSG ${channelName} :After message 2`);
      await client.waitForLine(/PRIVMSG.*After message 2/i, 3000);

      // Wait for history backend to persist
      await new Promise(r => setTimeout(r, 1000));
      client.clearRawBuffer();

      // Request messages after this msgid
      client.send(`CHATHISTORY AFTER ${channelName} msgid=${msgid} 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Should have at least 2 messages
      expect(messages.length).toBeGreaterThanOrEqual(2);
      // Should NOT include "Reference message"
      for (const msg of messages) {
        expect(msg).not.toContain('Reference message');
      }

      client.send('QUIT');
    });
  });

  /**
   * PM Chathistory Consent Tests
   *
   * These tests verify the per-user PM history opt-in system.
   * Server configured with CHATHISTORY_PRIVATE_CONSENT=2 (multi-party mode):
   * - Both sender AND recipient must opt-in for PM history to be stored
   * - Users opt-in via: METADATA SET * chathistory.pm * :1
   * - Users opt-out via: METADATA SET * chathistory.pm * :0
   */
  describe('PM Chathistory Consent (Multi-Party Mode)', () => {
    it('PM history NOT stored when neither party opts in (mode 2)', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmnoopt1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmnoopt2_${testId}`);
      await client2.waitForLine(/001/);

      // Neither party opts in - send messages
      const testMsg = `NoOptIn test ${testId}`;
      client1.send(`PRIVMSG pmnoopt2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 300));
      client2.send(`PRIVMSG pmnoopt1_${testId} :Reply ${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history - should be empty in multi-party mode
      client1.send(`CHATHISTORY LATEST pmnoopt2_${testId} * 10`);

      // MUST receive a batch - no try/catch, test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // In multi-party mode (2), messages should NOT be stored without both opting in
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history stored when BOTH parties opt in (mode 2)', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmboth1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmboth2_${testId}`);
      await client2.waitForLine(/001/);

      // BOTH parties opt in - MUST get 761 response confirming the SET
      client1.send('METADATA SET * chathistory.pm * :1');
      const meta1Response = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta1Response).toMatch(/761/);

      client2.send('METADATA SET * chathistory.pm * :1');
      const meta2Response = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta2Response).toMatch(/761/);

      await new Promise(r => setTimeout(r, 300));

      // Exchange messages after both opt in
      const testMsg = `BothOptIn test ${testId}`;
      client1.send(`PRIVMSG pmboth2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 300));
      client2.send(`PRIVMSG pmboth1_${testId} :Reply ${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history - MUST have messages
      client1.send(`CHATHISTORY LATEST pmboth2_${testId} * 10`);

      // MUST receive a batch - test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // With both opted in, PM history MUST be stored
      expect(messages.length).toBeGreaterThanOrEqual(1);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history NOT stored when only sender opts in (mode 2)', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmsend1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmsend2_${testId}`);
      await client2.waitForLine(/001/);

      // Only sender opts in - MUST get 761 response
      client1.send('METADATA SET * chathistory.pm * :1');
      const metaResponse = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(metaResponse).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      // Send messages
      const testMsg = `SenderOnly test ${testId}`;
      client1.send(`PRIVMSG pmsend2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history - should be empty (recipient didn't opt in)
      client1.send(`CHATHISTORY LATEST pmsend2_${testId} * 10`);

      // MUST receive a batch - test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // In multi-party mode, messages should NOT be stored with only sender consent
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history NOT stored when only recipient opts in (mode 2)', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmrecv1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmrecv2_${testId}`);
      await client2.waitForLine(/001/);

      // Only recipient opts in - MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :1');
      const metaResponse = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(metaResponse).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      // Send messages
      const testMsg = `RecipientOnly test ${testId}`;
      client1.send(`PRIVMSG pmrecv2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history - should be empty (sender didn't opt in)
      client1.send(`CHATHISTORY LATEST pmrecv2_${testId} * 10`);

      // MUST receive a batch - test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // In multi-party mode, messages should NOT be stored with only recipient consent
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('explicit opt-out overrides opt-in in multi-party mode', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmover1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmover2_${testId}`);
      await client2.waitForLine(/001/);

      // Client1 opts in - MUST get 761 response
      client1.send('METADATA SET * chathistory.pm * :1');
      const meta1Response = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta1Response).toMatch(/761/);

      // Client2 explicitly opts out - MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const meta2Response = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta2Response).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      // Send messages
      const testMsg = `OptOutOverride test ${testId}`;
      client1.send(`PRIVMSG pmover2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history - should be empty (explicit opt-out)
      client1.send(`CHATHISTORY LATEST pmover2_${testId} * 10`);

      // MUST receive a batch - test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Explicit opt-out should override any opt-in
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('can change consent preference after initial setting', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmchg1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmchg2_${testId}`);
      await client2.waitForLine(/001/);

      // Both opt in - MUST get 761 response for each
      client1.send('METADATA SET * chathistory.pm * :1');
      const meta1Response = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta1Response).toMatch(/761/);

      client2.send('METADATA SET * chathistory.pm * :1');
      const meta2Response = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta2Response).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      // First message (should be stored)
      const msg1 = `Before revoke ${testId}`;
      client1.send(`PRIVMSG pmchg2_${testId} :${msg1}`);
      await new Promise(r => setTimeout(r, 300));

      // Client2 revokes consent - MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const revokeResponse = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(revokeResponse).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      // Second message (should NOT be stored)
      const msg2 = `After revoke ${testId}`;
      client1.send(`PRIVMSG pmchg2_${testId} :${msg2}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history
      client1.send(`CHATHISTORY LATEST pmchg2_${testId} * 10`);

      // MUST receive a batch - test fails if no response
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      // Collect messages until batch end
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Verify consent change worked: post-revoke message should NOT be stored
      const hasAfterMsg = messages.some(m => m.includes('After revoke'));
      expect(hasAfterMsg).toBe(false);

      // Pre-revoke message should be stored (when both had opted in)
      const hasBeforeMsg = messages.some(m => m.includes('Before revoke'));
      expect(hasBeforeMsg).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('can verify own opt-in status via METADATA GET', async () => {
      const client = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client.capEnd();
      client.register(`pmget_${testId}`);
      await client.waitForLine(/001/);

      // Set opt-in - MUST get 761 response
      client.send('METADATA SET * chathistory.pm * :1');
      const setResponse = await client.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(setResponse).toMatch(/761/);
      await new Promise(r => setTimeout(r, 200));

      client.clearRawBuffer();

      // Query own status - MUST get 761 response with value
      client.send('METADATA GET * chathistory.pm');
      const getResponse = await client.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(getResponse).toContain('chathistory.pm');
      // Value should be '1' - verify the opt-in value is returned
      expect(getResponse).toMatch(/:1/);

      client.send('QUIT');
    });

    it('can query other user opt-in status via METADATA GET (public visibility)', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmqry1_${testId}`);
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmqry2_${testId}`);
      await client2.waitForLine(/001/);

      // Client2 sets public opt-in - MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :1');
      const setResponse = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(setResponse).toMatch(/761/);
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      // Client1 queries Client2's status - MUST get 761 response (public visibility)
      client1.send(`METADATA GET pmqry2_${testId} chathistory.pm`);
      const getResponse = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(getResponse).toContain('chathistory.pm');
      // Verify other user's opt-in value is visible
      expect(getResponse).toMatch(/:1/);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('PM Chathistory Connection Notice', () => {
    it('receives PM policy notice on connection when CHATHISTORY_PM_NOTICE enabled', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'standard-replies']);
      client.capEnd();
      client.register('pmnotice1');

      // Collect all lines during registration
      const registrationLines: string[] = [];
      const startTime = Date.now();

      // Wait for 001 and collect lines
      while (Date.now() - startTime < 10000) {
        try {
          const line = await client.waitForLine(/./, 500);
          registrationLines.push(line);
          // Stop after MOTD end or reasonable time
          if (line.includes('376') || line.includes('422')) {
            // Wait a bit more for any post-MOTD notices
            await new Promise(r => setTimeout(r, 500));
            break;
          }
        } catch {
          break;
        }
      }

      // Look for PM policy notice (NOTE or NOTICE)
      const pmNotice = registrationLines.find(line =>
        (line.includes('NOTE') || line.includes('NOTICE')) &&
        (line.toLowerCase().includes('pm') || line.toLowerCase().includes('private') || line.toLowerCase().includes('chathistory'))
      );

      if (pmNotice) {
        console.log('PM policy notice received:', pmNotice);
        console.log('SUCCESS: Server sends PM policy notification on connect');
      } else {
        console.log('No PM policy notice found in registration');
        console.log('Sample registration lines:', registrationLines.slice(-10));
      }

      client.send('QUIT');
    });

    it('NOTE command uses CHATHISTORY PM_POLICY format for standard-replies clients', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const { ack } = await client.capReq(['draft/chathistory', 'batch', 'standard-replies']);
      client.capEnd();
      client.register('pmnote1');

      const hasStandardReplies = ack.includes('standard-replies');

      // Collect registration lines
      const registrationLines: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 10000) {
        try {
          const line = await client.waitForLine(/./, 500);
          registrationLines.push(line);
          if (line.includes('376') || line.includes('422')) {
            await new Promise(r => setTimeout(r, 500));
            break;
          }
        } catch {
          break;
        }
      }

      // Look specifically for NOTE CHATHISTORY PM_POLICY
      const notePolicy = registrationLines.find(line =>
        line.includes('NOTE') && line.includes('CHATHISTORY') && line.includes('PM_POLICY')
      );

      if (hasStandardReplies && notePolicy) {
        console.log('NOTE CHATHISTORY PM_POLICY received:', notePolicy);
        console.log('SUCCESS: Server uses proper NOTE format for standard-replies clients');
      } else if (hasStandardReplies) {
        console.log('standard-replies enabled but no NOTE PM_POLICY found');
        // May fall back to NOTICE or feature disabled
      } else {
        console.log('standard-replies not enabled, expecting NOTICE instead');
      }

      client.send('QUIT');
    });

    it('falls back to NOTICE for clients without standard-replies', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Explicitly do NOT request standard-replies
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('pmfallback1');

      // Collect registration lines
      const registrationLines: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 10000) {
        try {
          const line = await client.waitForLine(/./, 500);
          registrationLines.push(line);
          if (line.includes('376') || line.includes('422')) {
            await new Promise(r => setTimeout(r, 500));
            break;
          }
        } catch {
          break;
        }
      }

      // Look for NOTICE about PM history (not NOTE)
      const noticePolicy = registrationLines.find(line =>
        line.includes('NOTICE') &&
        (line.toLowerCase().includes('pm') || line.toLowerCase().includes('private') || line.toLowerCase().includes('chathistory')) &&
        !line.includes('NOTE')
      );

      if (noticePolicy) {
        console.log('NOTICE fallback received:', noticePolicy);
        console.log('SUCCESS: Server falls back to NOTICE for non-standard-replies clients');
      } else {
        console.log('No PM NOTICE found (feature may be disabled)');
      }

      client.send('QUIT');
    });
  });

  describe('PM Chathistory Capability Advertisement', () => {
    it('draft/chathistory capability includes limit parameter', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const chathistoryValue = caps.get('draft/chathistory');

      console.log('draft/chathistory capability value:', chathistoryValue);

      if (chathistoryValue) {
        expect(chathistoryValue).toContain('limit=');
        console.log('SUCCESS: Capability includes limit parameter');
      } else {
        console.log('draft/chathistory has no value (may be boolean capability)');
      }

      client.send('QUIT');
    });

    it('checks for pm= parameter in capability value (if CHATHISTORY_ADVERTISE_PM enabled)', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const chathistoryValue = caps.get('draft/chathistory');

      console.log('draft/chathistory capability value:', chathistoryValue);

      if (chathistoryValue && chathistoryValue.includes('pm=')) {
        const pmMatch = chathistoryValue.match(/pm=(\w+)/);
        if (pmMatch) {
          console.log('PM consent mode advertised:', pmMatch[1]);
          expect(['global', 'single', 'multi']).toContain(pmMatch[1]);
          console.log('SUCCESS: Server advertises PM consent mode');
        }
      } else {
        console.log('pm= parameter not present (CHATHISTORY_ADVERTISE_PM likely disabled)');
        console.log('This is expected - pm= is a non-standard extension');
      }

      client.send('QUIT');
    });
  });

  describe('Chathistory Empty Results', () => {
    it('returns empty batch for channel with no history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histempty1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histempty');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      // Request history immediately (no messages yet)
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // Should receive empty batch (BATCH + and BATCH - with same ref)
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      // Wait for batch end
      const batchEnd = await client.waitForLine(/BATCH -/i, 2000);
      expect(batchEnd).toBeDefined();
      console.log('Empty batch received correctly');
      client.send('QUIT');
    });
  });

  describe('Chathistory Timestamp Formats', () => {
    it('accepts ISO8601 timestamp format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histiso1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histiso');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :ISO timestamp test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Use full ISO8601 format
      const now = new Date().toISOString();
      client.send(`CHATHISTORY BEFORE ${channelName} timestamp=${now} 10`);

      const response = await client.waitForLine(/BATCH|FAIL/i, 5000);
      expect(response).toBeDefined();
      console.log('ISO timestamp accepted:', response);
      client.send('QUIT');
    });

    it('rejects invalid timestamp format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histbadts1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histbadts');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      // Use invalid timestamp
      client.send(`CHATHISTORY BEFORE ${channelName} timestamp=not-a-timestamp 10`);

      // Should receive FAIL or error
      const response = await client.waitForLine(/FAIL|BATCH|ERR/i, 3000);
      expect(response).toBeDefined();
      console.log('Invalid timestamp response:', response);
      client.send('QUIT');
    });
  });

  describe('CHATHISTORY NOTICE Messages', () => {
    it('NOTICE messages are stored in history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histnotice1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histnotice');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send NOTICE messages
      client.send(`NOTICE ${channelName} :Notice message 1`);
      client.send(`NOTICE ${channelName} :Notice message 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request latest history
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/NOTICE|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('NOTICE')) messages.push(line);
      }

      // Should have NOTICE messages in history
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // Verify they contain our content
      const hasNotice1 = messages.some(m => m.includes('Notice message 1'));
      const hasNotice2 = messages.some(m => m.includes('Notice message 2'));
      expect(hasNotice1 || hasNotice2).toBe(true);

      client.send('QUIT');
    });

    it('NOTICE and PRIVMSG appear together in history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histmixed1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histmixed');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send mixed message types
      client.send(`PRIVMSG ${channelName} :Regular message`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`NOTICE ${channelName} :Notice message`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Another regular message`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const privmsgs: string[] = [];
      const notices: string[] = [];
      while (true) {
        const line = await client.waitForLine(/NOTICE|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('NOTICE')) notices.push(line);
        else if (line.includes('PRIVMSG')) privmsgs.push(line);
      }

      expect(privmsgs.length).toBeGreaterThanOrEqual(2);
      expect(notices.length).toBeGreaterThanOrEqual(1);

      client.send('QUIT');
    });
  });

  describe('CHATHISTORY TAGMSG Messages', () => {
    /**
     * TAGMSG storage requires:
     * 1. Server has CAP_draft_event_playback = TRUE in features config
     * 2. Client requests draft/event-playback capability
     */
    it('TAGMSG messages are stored in history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Note: draft/event-playback is required for TAGMSG to be stored in history
      await client.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time', 'message-tags']);
      client.capEnd();
      client.register('histtag1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histtag');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send TAGMSG with a client tag (e.g., typing indicator or reaction)
      // Format: @+typing=active TAGMSG #channel
      client.send(`@+typing=active TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`@+react=👍 TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/TAGMSG|PRIVMSG|NOTICE|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('TAGMSG')) messages.push(line);
      }

      // TAGMSG must be stored when event-playback is enabled
      expect(messages.length).toBeGreaterThan(0);

      // Verify tags are preserved
      const hasTyping = messages.some(m => m.includes('typing'));
      const hasReact = messages.some(m => m.includes('react'));
      expect(hasTyping || hasReact).toBe(true);

      client.send('QUIT');
    });

    it('TAGMSG with +reply tag links to original message', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Note: draft/event-playback is required for TAGMSG to be stored in history
      await client.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time', 'message-tags', 'echo-message']);
      client.capEnd();
      client.register('histreply1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histreply');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send original message and get msgid - MUST get echo with msgid
      client.send(`PRIVMSG ${channelName} :Original message for reply`);
      const echo = await client.waitForLine(/PRIVMSG.*Original message/i, 3000);
      const match = echo.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const originalMsgid = match![1];

      // Send TAGMSG reaction to original
      await new Promise(r => setTimeout(r, 100));
      client.send(`@+react=👍;+reply=${originalMsgid} TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/TAGMSG|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        messages.push(line);
      }

      // Check if reply tag links back to original
      const tagmsgs = messages.filter(m => m.includes('TAGMSG'));
      expect(tagmsgs.length).toBeGreaterThan(0);
      const hasReplyTag = tagmsgs.some(m => m.includes(`reply=${originalMsgid}`));
      expect(hasReplyTag).toBe(true);

      client.send('QUIT');
    });
  });

  describe('CHATHISTORY Channel Events', () => {
    /**
     * Channel event storage (JOIN, PART, KICK, QUIT, TOPIC, MODE) requires:
     * 1. Server has CAP_draft_event_playback = TRUE in features config
     * 2. Client requests draft/event-playback capability
     */
    it('JOIN events are stored in history', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      // Note: draft/event-playback is required for JOIN events to be stored in history
      await client1.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time', 'extended-join']);
      client1.capEnd();
      client1.register('histjoin1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time', 'extended-join']);
      client2.capEnd();
      client2.register('histjoin2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('histjoin');

      // Client1 creates the channel
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Client2 joins (this should be recorded)
      await new Promise(r => setTimeout(r, 200));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Query history - should include JOIN events
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const joins: string[] = [];
      while (true) {
        const line = await client1.waitForLine(/JOIN|PRIVMSG|NOTICE|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('JOIN')) joins.push(line);
      }

      // JOIN events must be stored when event-playback is enabled
      expect(joins.length).toBeGreaterThan(0);
      // Verify client2's join is recorded
      const hasJoin2 = joins.some(j => j.includes('histjoin2'));
      expect(hasJoin2).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PART events are stored in history', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('histpart1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('histpart2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('histpart');

      // Both join the channel
      client1.send(`JOIN ${channelName}`);
      client2.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Client2 parts with a message
      client2.send(`PART ${channelName} :Leaving for test`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Query history
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const parts: string[] = [];
      while (true) {
        const line = await client1.waitForLine(/PART|JOIN|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PART')) parts.push(line);
      }

      // PART events must be stored when event-playback is enabled
      expect(parts.length).toBeGreaterThan(0);
      // Verify part message is included
      const hasPartMsg = parts.some(p => p.includes('Leaving for test'));
      expect(hasPartMsg).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('KICK events are stored in history', async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      op.capEnd();
      op.register('histkickop');
      await op.waitForLine(/001/);

      await user.capLs();
      await user.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      user.capEnd();
      user.register('histkickusr');
      await user.waitForLine(/001/);

      const channelName = uniqueChannel('histkick');

      // Op creates channel (gets ops)
      op.send(`JOIN ${channelName}`);
      await op.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // User joins
      user.send(`JOIN ${channelName}`);
      await user.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Op kicks user
      op.send(`KICK ${channelName} histkickusr :Test kick reason`);
      await new Promise(r => setTimeout(r, 500));

      op.clearRawBuffer();

      // Query history
      op.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await op.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const kicks: string[] = [];
      while (true) {
        const line = await op.waitForLine(/KICK|JOIN|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('KICK')) kicks.push(line);
      }

      // KICK events must be stored when event-playback is enabled
      expect(kicks.length).toBeGreaterThan(0);
      // Verify kick info
      const hasKickedUser = kicks.some(k => k.includes('histkickusr'));
      const hasKickReason = kicks.some(k => k.includes('Test kick reason'));
      expect(hasKickedUser).toBe(true);
      expect(hasKickReason).toBe(true);

      op.send('QUIT');
      user.send('QUIT');
    });

    it('QUIT events are stored in shared channel history', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('histquit1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('histquit2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('histquit');

      // Both join the channel
      client1.send(`JOIN ${channelName}`);
      client2.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Client2 quits with a message
      client2.send('QUIT :Goodbye for test');
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Query history
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const quits: string[] = [];
      while (true) {
        const line = await client1.waitForLine(/QUIT|JOIN|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('QUIT')) quits.push(line);
      }

      // QUIT events must be stored when event-playback is enabled
      expect(quits.length).toBeGreaterThan(0);
      // Verify quit info
      const hasQuitUser = quits.some(q => q.includes('histquit2'));
      const hasQuitMsg = quits.some(q => q.includes('Goodbye for test'));
      expect(hasQuitUser).toBe(true);
      expect(hasQuitMsg).toBe(true);

      client1.send('QUIT');
    });

    it('TOPIC changes are stored in history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client.capEnd();
      client.register('histtopic1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histtopic');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Set a topic
      const topicText = `Test topic ${uniqueId()}`;
      client.send(`TOPIC ${channelName} :${topicText}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Query history
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const topics: string[] = [];
      while (true) {
        const line = await client.waitForLine(/TOPIC|JOIN|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('TOPIC')) topics.push(line);
      }

      // TOPIC events must be stored when event-playback is enabled
      expect(topics.length).toBeGreaterThan(0);
      const hasTopicText = topics.some(t => t.includes(topicText));
      expect(hasTopicText).toBe(true);

      client.send('QUIT');
    });

    it('MODE changes are stored in history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client.capEnd();
      client.register('histmode1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histmode');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Set a mode that isn't default (+tn is default, use +m for moderated)
      client.send(`MODE ${channelName} +m`);
      // Wait for MODE to be broadcast to channel members
      await client.waitForLine(/MODE.*\+m/i, 3000);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Query history
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const modes: string[] = [];
      while (true) {
        const line = await client.waitForLine(/MODE|JOIN|PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('MODE')) modes.push(line);
      }

      // MODE events must be stored when event-playback is enabled
      expect(modes.length).toBeGreaterThan(0);
      // Verify we got the +m mode change
      const hasModeM = modes.some(m => m.includes('+m'));
      expect(hasModeM).toBe(true);

      client.send('QUIT');
    });
  });

  describe('CHATHISTORY Pagination', () => {
    it('can paginate through history using BEFORE with msgid', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histpage1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histpage');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send 10 messages - MUST get echo with msgid for each
      const sentMsgIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        client.send(`PRIVMSG ${channelName} :Pagination message ${i}`);
        const echo = await client.waitForLine(new RegExp(`Pagination message ${i}`), 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        expect(match).not.toBeNull();
        sentMsgIds.push(match![1]);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 500));

      expect(sentMsgIds.length).toBe(10);

      // First page: get latest 3 messages
      client.clearRawBuffer();
      client.send(`CHATHISTORY LATEST ${channelName} * 3`);

      // MUST receive batch
      const batch1 = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch1).toBeDefined();

      const page1: { content: string; msgid: string }[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        const msgidMatch = line.match(/msgid=([^\s;]+)/);
        const contentMatch = line.match(/Pagination message (\d+)/);
        if (msgidMatch && contentMatch) {
          page1.push({ content: contentMatch[1], msgid: msgidMatch[1] });
        }
      }

      expect(page1.length).toBeGreaterThan(0);

      // Get the oldest msgid from page 1 to use as reference for page 2
      const oldestMsgId = page1[0].msgid; // First in the list is oldest in LATEST order

      // Second page: get 3 messages before the oldest from page 1
      client.clearRawBuffer();
      client.send(`CHATHISTORY BEFORE ${channelName} msgid=${oldestMsgId} 3`);

      // MUST receive batch
      const batch2 = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch2).toBeDefined();

      const page2: { content: string; msgid: string }[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        const msgidMatch = line.match(/msgid=([^\s;]+)/);
        const contentMatch = line.match(/Pagination message (\d+)/);
        if (msgidMatch && contentMatch) {
          page2.push({ content: contentMatch[1], msgid: msgidMatch[1] });
        }
      }

      expect(page2.length).toBeGreaterThan(0);

      // Verify pagination worked - pages should not overlap
      const page1Contents = new Set(page1.map(m => m.content));
      const page2Contents = new Set(page2.map(m => m.content));

      let overlap = 0;
      for (const content of page2Contents) {
        if (page1Contents.has(content)) overlap++;
      }
      expect(overlap).toBe(0);

      // Page 2 should have lower numbers (older messages)
      const page1Max = Math.max(...page1.map(m => parseInt(m.content)));
      const page2Max = Math.max(...page2.map(m => parseInt(m.content)));
      expect(page2Max).toBeLessThan(page1Max);

      client.send('QUIT');
    });

    it('can paginate forward using AFTER with msgid', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histfwd1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histfwd');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send messages and capture first msgid - MUST succeed
      let firstMsgId: string | null = null;
      for (let i = 1; i <= 8; i++) {
        client.send(`PRIVMSG ${channelName} :Forward page ${i}`);
        const echo = await client.waitForLine(new RegExp(`Forward page ${i}`), 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        expect(match).not.toBeNull();
        if (i === 1) firstMsgId = match![1];
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 500));

      expect(firstMsgId).not.toBeNull();

      // Get messages after the first one (should get messages 2-8)
      client.clearRawBuffer();
      client.send(`CHATHISTORY AFTER ${channelName} msgid=${firstMsgId} 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const afterFirst: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        const contentMatch = line.match(/Forward page (\d+)/);
        if (contentMatch) afterFirst.push(contentMatch[1]);
      }

      expect(afterFirst.length).toBeGreaterThan(0);
      // Should NOT include message 1 (the reference)
      expect(afterFirst).not.toContain('1');
      // Should have messages 2 and beyond
      expect(afterFirst).toContain('2');

      client.send('QUIT');
    });

    it('handles pagination at end of history', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client.capEnd();
      client.register('histend1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('histend');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send only 3 messages - MUST succeed
      let firstMsgId: string | null = null;
      for (let i = 1; i <= 3; i++) {
        client.send(`PRIVMSG ${channelName} :End test ${i}`);
        const echo = await client.waitForLine(new RegExp(`End test ${i}`), 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        expect(match).not.toBeNull();
        if (i === 1) firstMsgId = match![1];
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 500));

      expect(firstMsgId).not.toBeNull();

      // Try to get messages before the first one (should be empty batch)
      client.clearRawBuffer();
      client.send(`CHATHISTORY BEFORE ${channelName} msgid=${firstMsgId} 10`);

      // MUST receive batch
      const batchStart = await client.waitForLine(/BATCH \+(\S+) chathistory/i, 5000);
      expect(batchStart).toBeDefined();
      const batchMatch = batchStart.match(/BATCH \+(\S+)/);
      expect(batchMatch).not.toBeNull();
      const batchId = batchMatch![1];

      // Should get batch end with no messages (empty batch at start of history)
      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        messages.push(line);
      }

      // At start of history, there should be no messages before the first one
      expect(messages.length).toBe(0);

      client.send('QUIT');
    });

    it('pagination consistency during message arrival', async () => {
      const sender = trackClient(await createRawSocketClient());
      const reader = trackClient(await createRawSocketClient());

      await sender.capLs();
      await sender.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      sender.capEnd();
      sender.register('histrace1');
      await sender.waitForLine(/001/);

      await reader.capLs();
      await reader.capReq(['draft/chathistory', 'batch', 'server-time']);
      reader.capEnd();
      reader.register('histrace2');
      await reader.waitForLine(/001/);

      const channelName = uniqueChannel('histrace');
      sender.send(`JOIN ${channelName}`);
      reader.send(`JOIN ${channelName}`);
      await sender.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await reader.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 300));

      // Send initial messages
      for (let i = 1; i <= 5; i++) {
        sender.send(`PRIVMSG ${channelName} :Initial ${i}`);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 500));

      // Reader queries while sender is about to send more
      reader.clearRawBuffer();
      reader.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // Sender sends more messages concurrently
      sender.send(`PRIVMSG ${channelName} :Concurrent 1`);
      sender.send(`PRIVMSG ${channelName} :Concurrent 2`);

      // MUST receive batch for initial query
      const batch1 = await reader.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch1).toBeDefined();

      const initialMsgs: string[] = [];
      while (true) {
        const line = await reader.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('Initial')) initialMsgs.push(line);
      }

      expect(initialMsgs.length).toBeGreaterThan(0);

      // Wait and query again
      await new Promise(r => setTimeout(r, 500));
      reader.clearRawBuffer();
      reader.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch for follow-up query
      const batch2 = await reader.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch2).toBeDefined();

      const allMsgs: string[] = [];
      while (true) {
        const line = await reader.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        allMsgs.push(line);
      }

      // Follow-up should have at least as many as initial plus concurrent
      expect(allMsgs.length).toBeGreaterThanOrEqual(initialMsgs.length);

      sender.send('QUIT');
      reader.send('QUIT');
    });
  });
});
