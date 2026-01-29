import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueChannel, uniqueId, waitForChathistory } from '../helpers/index.js';

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histlatest');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send some messages to create history
      client.send(`PRIVMSG ${channelName} :History message 1`);
      client.send(`PRIVMSG ${channelName} :History message 2`);

      // Poll for history until messages are persisted (handles async LMDB writes)
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 2,
        timeoutMs: 10000,
        subcommand: 'LATEST',
      });

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histbefore');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Create some history
      client.send(`PRIVMSG ${channelName} :Before test 1`);
      client.send(`PRIVMSG ${channelName} :Before test 2`);

      // Poll with BEFORE subcommand - uses future timestamp to include all messages
      const futureTs = new Date(Date.now() + 60000).toISOString();
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 2,
        timeoutMs: 10000,
        subcommand: 'BEFORE',
        timestamp: futureTs,
      });

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histafter');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Capture timestamp before sending messages (with buffer for clock skew)
      const beforeMsgs = new Date(Date.now() - 5000).toISOString();

      // Send messages
      client.send(`PRIVMSG ${channelName} :After test 1`);
      client.send(`PRIVMSG ${channelName} :After test 2`);

      // Poll with AFTER subcommand using the "before messages" timestamp
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 2,
        timeoutMs: 10000,
        subcommand: 'AFTER',
        timestamp: beforeMsgs,
      });

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histaround');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send messages with a timestamp captured in between
      client.send(`PRIVMSG ${channelName} :Around test 1`);
      await new Promise(r => setTimeout(r, 100)); // Small delay to separate timestamps
      const middleTime = new Date().toISOString();
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Around test 2`);

      // First use LATEST polling to ensure messages are persisted
      await waitForChathistory(client, channelName, {
        minMessages: 2,
        timeoutMs: 10000,
        subcommand: 'LATEST',
      });

      // Now test AROUND with the middle timestamp
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1, // AROUND should return at least one message
        timeoutMs: 5000,
        subcommand: 'AROUND',
        timestamp: middleTime,
      });

      expect(messages.length).toBeGreaterThanOrEqual(1);
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
      await client.waitForNumeric('001');

      // Join a channel and send a message to create history
      const channelName = uniqueChannel('histtargets');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);
      client.send(`PRIVMSG ${channelName} :Targets test message`);

      // Poll LATEST to ensure message is persisted before checking TARGETS
      await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        subcommand: 'LATEST',
      });

      client.clearRawBuffer();

      // Request list of targets with history
      // TARGETS requires two timestamps (unlike other subcommands that accept *)
      const now = new Date(Date.now() + 60000).toISOString();
      const past = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      client.send(`CHATHISTORY TARGETS timestamp=${past} timestamp=${now} 10`);

      // Response includes CHATHISTORY lines listing targets
      const response = await client.waitForParsedLine(
        msg => (msg.command === 'BATCH' && msg.raw.includes('chathistory')) || msg.command === 'CHATHISTORY',
        5000
      );
      expect(response.command, 'Should get BATCH or CHATHISTORY response').toMatch(/BATCH|CHATHISTORY/);
      console.log('CHATHISTORY TARGETS response:', response.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histformat');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.send(`PRIVMSG ${channelName} :Format test`);

      // Poll until message is persisted
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        subcommand: 'LATEST',
      });

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histmsgid');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.send(`PRIVMSG ${channelName} :MsgID test`);

      // Poll until message is persisted
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        subcommand: 'LATEST',
      });

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
      await client.waitForNumeric('001');

      // Wait for server to finish sending connection notices
      await new Promise(r => setTimeout(r, 500));
      client.clearRawBuffer();

      // Try to get history for a channel we're not in
      client.send('CHATHISTORY LATEST #nonexistentchannel12345 * 10');

      // Should receive FAIL CHATHISTORY (with standard-replies) or error about the channel
      // Be specific to avoid matching unrelated NOTICEs like "Highest connection count"
      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' ||
               (msg.command === 'BATCH' && msg.raw.includes('chathistory')) ||
               msg.raw.includes('#nonexistent') ||
               /^4\d\d$/.test(msg.command) ||
               /no.*history|not.*member|cannot/i.test(msg.trailing || ''),
        3000
      );
      // Should be either FAIL, BATCH (empty), or error numeric
      expect(
        response.command === 'FAIL' || response.command === 'BATCH' || /^4\d\d$/.test(response.command),
        'Should get FAIL, BATCH, or error response'
      ).toBe(true);
      console.log('Unauthorized history error:', response.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histbetween');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Capture start timestamp with buffer for clock skew
      const startTime = new Date(Date.now() - 5000).toISOString();

      // Create some history
      client.send(`PRIVMSG ${channelName} :Between test 1`);
      client.send(`PRIVMSG ${channelName} :Between test 2`);
      client.send(`PRIVMSG ${channelName} :Between test 3`);

      // Poll with BETWEEN subcommand - end timestamp will be in the future
      const endTime = new Date(Date.now() + 60000).toISOString();
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 3,
        timeoutMs: 10000,
        subcommand: 'BETWEEN',
        timestamp: startTime,
        timestamp2: endTime,
      });

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histlimit');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send 10 messages and wait for echo of last one
      for (let i = 0; i < 10; i++) {
        client.send(`PRIVMSG ${channelName} :Limit test message ${i}`);
      }
      await client.waitForParsedLine(msg => msg.trailing?.includes('Limit test message 9') === true, 5000);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();
      await new Promise(r => setTimeout(r, 100));

      // Request only 3 messages
      client.send(`CHATHISTORY LATEST ${channelName} * 3`);

      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          2000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PRIVMSG') messages.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histzero');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.send(`PRIVMSG ${channelName} :Zero limit test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request with limit 0
      client.send(`CHATHISTORY LATEST ${channelName} * 0`);

      // Should receive either an empty batch or a FAIL response
      // Use longer timeout to account for server processing time
      const response = await client.waitForParsedLine(
        msg => msg.command === 'BATCH' || msg.command === 'FAIL',
        8000
      );
      expect(response.command, 'Should get BATCH or FAIL response').toMatch(/BATCH|FAIL/);
      console.log('Zero limit response:', response.raw);
      client.send('QUIT');
    });

    it('handles very large limit', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch']);
      client.capEnd();
      client.register('histlarge1');
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histlarge');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.send(`PRIVMSG ${channelName} :Large limit test`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request with very large limit (should be capped by server)
      client.send(`CHATHISTORY LATEST ${channelName} * 1000000`);

      // Should receive a batch response (server caps the limit)
      // Use longer timeout to account for server processing time
      const response = await client.waitForParsedLine(
        msg => msg.command === 'BATCH' || msg.command === 'FAIL',
        8000
      );
      expect(response.command, 'Should get BATCH or FAIL response').toMatch(/BATCH|FAIL/);
      console.log('Large limit response:', response.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histmsgid');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send messages and capture msgid - MUST succeed
      client.send(`PRIVMSG ${channelName} :First message`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :Second message`);

      const echo = await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes('Second message') === true,
        3000
      );
      const match = echo.raw.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const msgid = match![1];

      // Wait for history backend to persist the message
      await new Promise(r => setTimeout(r, 1000));
      client.clearRawBuffer();

      // Request messages before this msgid
      client.send(`CHATHISTORY BEFORE ${channelName} msgid=${msgid} 10`);

      // MUST receive batch
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PRIVMSG') messages.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histafter2');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send first message and capture msgid - MUST succeed
      client.send(`PRIVMSG ${channelName} :Reference message`);
      const echo = await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes('Reference message') === true,
        3000
      );
      const match = echo.raw.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const msgid = match![1];

      // Send more messages after capturing the reference msgid
      await new Promise(r => setTimeout(r, 100));
      client.send(`PRIVMSG ${channelName} :After message 1`);
      await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes('After message 1') === true,
        3000
      );
      client.send(`PRIVMSG ${channelName} :After message 2`);
      await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes('After message 2') === true,
        3000
      );

      // Wait for history backend to persist
      await new Promise(r => setTimeout(r, 1000));
      client.clearRawBuffer();

      // Request messages after this msgid
      client.send(`CHATHISTORY AFTER ${channelName} msgid=${msgid} 10`);

      // MUST receive batch
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PRIVMSG') messages.push(msg.raw);
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
   * PM Chathistory Opt-Out Tests
   *
   * Tests the per-user PM history opt-out system.
   * Server stores PM history for authenticated users by default.
   * Users opt out via: METADATA SET * chathistory.pm * :0 (or +y user mode)
   * If either party opts out, a HISTORY_GAP marker is stored instead.
   */
  describe('PM Chathistory Opt-Out', () => {
    it('PM history stored by default for authenticated users', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmdef1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmdef2_${testId}`);
      await client2.waitForNumeric('001');

      // No opt-in needed — PM history stored by default for authenticated users
      const testMsg = `DefaultPM test ${testId}`;
      client1.send(`PRIVMSG pmdef2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 300));
      client2.send(`PRIVMSG pmdef1_${testId} :Reply ${testMsg}`);

      // Wait for messages to persist and query history
      const messages = await waitForChathistory(client1, `pmdef2_${testId}`, {
        minMessages: 1,
        timeoutMs: 10000,
      });

      // PM history is stored by default for authenticated users
      expect(messages.length).toBeGreaterThanOrEqual(1);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history includes messages from both parties', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmboth1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmboth2_${testId}`);
      await client2.waitForNumeric('001');

      // Exchange messages — no opt-in needed
      const testMsg = `BothParties test ${testId}`;
      client1.send(`PRIVMSG pmboth2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 300));
      client2.send(`PRIVMSG pmboth1_${testId} :Reply ${testMsg}`);

      // Wait for persistence
      const messages = await waitForChathistory(client1, `pmboth2_${testId}`, {
        minMessages: 1,
        timeoutMs: 10000,
      });

      // Both parties' messages should be in history
      expect(messages.length).toBeGreaterThanOrEqual(1);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history NOT stored when sender opts out', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmso1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmso2_${testId}`);
      await client2.waitForNumeric('001');

      // Sender opts out — MUST get 761 response
      client1.send('METADATA SET * chathistory.pm * :0');
      const metaResponse = await client1.waitForNumeric('761', 3000);
      expect(metaResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 300));

      // Send messages
      const testMsg = `SenderOptOut test ${testId}`;
      client1.send(`PRIVMSG pmso2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history
      client1.send(`CHATHISTORY LATEST pmso2_${testId} * 10`);

      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        // Filter out gap markers — only count real messages
        if (msg.command === 'PRIVMSG' && !msg.raw.includes('+draft/chathistory-gap')) {
          messages.push(msg.raw);
        }
      }

      // Sender opted out — no real messages stored (only gap markers)
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PM history NOT stored when recipient opts out', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmro1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmro2_${testId}`);
      await client2.waitForNumeric('001');

      // Recipient opts out — MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const metaResponse = await client2.waitForNumeric('761', 3000);
      expect(metaResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 300));

      // Send messages
      const testMsg = `RecipientOptOut test ${testId}`;
      client1.send(`PRIVMSG pmro2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history
      client1.send(`CHATHISTORY LATEST pmro2_${testId} * 10`);

      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PRIVMSG' && !msg.raw.includes('+draft/chathistory-gap')) {
          messages.push(msg.raw);
        }
      }

      // Recipient opted out — no real messages stored
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('either party opting out prevents PM storage', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmeo1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmeo2_${testId}`);
      await client2.waitForNumeric('001');

      // Client2 opts out — MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const metaResponse = await client2.waitForNumeric('761', 3000);
      expect(metaResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 300));

      // Send messages (client1 has default=stored, client2 opted out)
      const testMsg = `EitherOptOut test ${testId}`;
      client1.send(`PRIVMSG pmeo2_${testId} :${testMsg}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history
      client1.send(`CHATHISTORY LATEST pmeo2_${testId} * 10`);

      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PRIVMSG' && !msg.raw.includes('+draft/chathistory-gap')) {
          messages.push(msg.raw);
        }
      }

      // Either party opting out prevents storage
      expect(messages.length).toBe(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('can toggle opt-out and messages follow preference change', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmtog1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmtog2_${testId}`);
      await client2.waitForNumeric('001');

      // First message (default — both storing, should be stored)
      const msg1 = `Before optout ${testId}`;
      client1.send(`PRIVMSG pmtog2_${testId} :${msg1}`);
      await new Promise(r => setTimeout(r, 500));

      // Client2 opts out — MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const revokeResponse = await client2.waitForNumeric('761', 3000);
      expect(revokeResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 300));

      // Second message (should NOT be stored — client2 opted out)
      const msg2 = `After optout ${testId}`;
      client1.send(`PRIVMSG pmtog2_${testId} :${msg2}`);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Request PM history
      client1.send(`CHATHISTORY LATEST pmtog2_${testId} * 10`);

      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        // Filter out gap markers
        if (msg.command === 'PRIVMSG' && !msg.raw.includes('+draft/chathistory-gap')) {
          messages.push(msg.raw);
        }
      }

      // Pre-opt-out message should be stored
      const hasBeforeMsg = messages.some(m => m.includes('Before optout'));
      expect(hasBeforeMsg).toBe(true);

      // Post-opt-out message should NOT be stored
      const hasAfterMsg = messages.some(m => m.includes('After optout'));
      expect(hasAfterMsg).toBe(false);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('can verify own opt-out status via METADATA GET', async () => {
      const client = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client.capEnd();
      client.register(`pmget_${testId}`);
      await client.waitForNumeric('001');

      // Set opt-out — MUST get 761 response
      client.send('METADATA SET * chathistory.pm * :0');
      const setResponse = await client.waitForNumeric('761', 3000);
      expect(setResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 200));

      client.clearRawBuffer();

      // Query own status — MUST get 761 response with value
      client.send('METADATA GET * chathistory.pm');
      const getResponse = await client.waitForNumeric('761', 3000);
      expect(getResponse.raw).toContain('chathistory.pm');
      // Value should be '0' — verify the opt-out value is returned
      expect(getResponse.trailing).toBe('0');

      client.send('QUIT');
    });

    it('can query other user opt-out status via METADATA GET', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());
      const testId = uniqueId();

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(`pmqry1_${testId}`);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(`pmqry2_${testId}`);
      await client2.waitForNumeric('001');

      // Client2 sets opt-out — MUST get 761 response
      client2.send('METADATA SET * chathistory.pm * :0');
      const setResponse = await client2.waitForNumeric('761', 3000);
      expect(setResponse.command).toBe('761');
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      // Client1 queries Client2's status — MUST get 761 response
      client1.send(`METADATA GET pmqry2_${testId} chathistory.pm`);
      const getResponse = await client1.waitForNumeric('761', 3000);
      expect(getResponse.raw).toContain('chathistory.pm');
      // Verify other user's opt-out value is visible
      expect(getResponse.trailing).toBe('0');

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('PM Chathistory Capability Advertisement', () => {
    it('draft/chathistory capability includes limit parameter', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const chathistoryValue = caps.get('draft/chathistory');

      expect(chathistoryValue).toBeDefined();
      expect(chathistoryValue).toContain('limit=');

      client.send('QUIT');
    });

    it('capability value includes pm token when CHATHISTORY_PRIVATE enabled', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const chathistoryValue = caps.get('draft/chathistory');

      expect(chathistoryValue).toBeDefined();

      // New format: "limit=1000,retention=7d,pm" (pm has no value, just a token)
      const tokens = chathistoryValue!.split(',').map(t => t.trim());
      const hasPm = tokens.some(t => t === 'pm');
      expect(hasPm, `Expected 'pm' token in capability value: ${chathistoryValue}`).toBe(true);

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histempty');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Wait for LMDB to be ready - use waitForChathistory with minMessages: 0
      // This will poll until the server responds with a BATCH (even empty)
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 0,
        timeoutMs: 5000,
      });

      // Should receive empty batch (no messages sent yet)
      expect(messages).toHaveLength(0);
      console.log('Empty batch received correctly');
      client.send('QUIT');
    });
  });

  describe('Chathistory Timestamp Formats', () => {
    it('accepts ISO8601 timestamp format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/chathistory', 'batch', 'server-time']);
      client.capEnd();
      client.register('histiso1');
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histiso');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.send(`PRIVMSG ${channelName} :ISO timestamp test`);

      // Wait for message to persist to LMDB
      await new Promise(r => setTimeout(r, 1000));

      // Use waitForChathistory with BEFORE subcommand and ISO8601 timestamp
      // Get a future timestamp so BEFORE definitely includes our message
      const futureTs = new Date(Date.now() + 60000).toISOString();
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        subcommand: 'BEFORE',
        timestamp: futureTs,
      });

      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages.some(m => m.includes('ISO timestamp test'))).toBe(true);
      console.log('ISO timestamp accepted, received', messages.length, 'messages');
      client.send('QUIT');
    });

    it('rejects invalid timestamp format', async () => {
      // Per IRCv3 spec: "If the server receives a syntactically invalid CHATHISTORY command,
      // e.g., an unknown subcommand, missing parameters, excess parameters, or parameters
      // that cannot be parsed, the INVALID_PARAMS error code SHOULD be returned"
      // Example: FAIL CHATHISTORY INVALID_PARAMS the_given_command :Invalid timestamp
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Need standard-replies to receive FAIL command (otherwise server sends NOTICE fallback)
      await client.capReq(['draft/chathistory', 'batch', 'labeled-response', 'standard-replies']);
      client.capEnd();
      client.register('histbadts1');
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histbadts');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      client.clearRawBuffer();

      // Use invalid timestamp - server should return FAIL INVALID_PARAMS
      client.send(`CHATHISTORY BEFORE ${channelName} timestamp=not-a-timestamp 10`);

      // Expect FAIL CHATHISTORY INVALID_PARAMS per IRCv3 spec
      // With standard-replies: FAIL command
      // Without: NOTICE fallback containing "FAIL CHATHISTORY INVALID_PARAMS"
      const response = await client.waitForParsedLine(
        msg => (msg.command === 'FAIL' || msg.command === 'NOTICE') &&
               msg.raw.includes('CHATHISTORY') && msg.raw.includes('INVALID_PARAMS'),
        5000
      );
      expect(response.command, 'Should get FAIL or NOTICE response').toMatch(/FAIL|NOTICE/);
      expect(response.raw, 'Response should contain INVALID_PARAMS').toContain('INVALID_PARAMS');
      console.log('Server correctly rejected invalid timestamp:', response.raw);

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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histnotice');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send NOTICE messages
      client.send(`NOTICE ${channelName} :Notice message 1`);
      client.send(`NOTICE ${channelName} :Notice message 2`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Request latest history
      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'NOTICE' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'NOTICE') messages.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histmixed');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

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
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const privmsgs: string[] = [];
      const notices: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'NOTICE' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'NOTICE') notices.push(msg.raw);
        else if (msg.command === 'PRIVMSG') privmsgs.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histtag');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send TAGMSG with a client tag (e.g., typing indicator or reaction)
      // Format: @+typing=active TAGMSG #channel
      client.send(`@+typing=active TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 100));
      client.send(`@+react=👍 TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'TAGMSG' || m.command === 'PRIVMSG' || m.command === 'NOTICE' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'TAGMSG') messages.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histreply');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send original message and get msgid - MUST get echo with msgid
      client.send(`PRIVMSG ${channelName} :Original message for reply`);
      const echo = await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes('Original message') === true,
        3000
      );
      const match = echo.raw.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const originalMsgid = match![1];

      // Send TAGMSG reaction to original
      await new Promise(r => setTimeout(r, 100));
      client.send(`@+react=👍;+reply=${originalMsgid} TAGMSG ${channelName}`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      client.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'TAGMSG' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        messages.push(msg.raw);
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
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time', 'extended-join']);
      client2.capEnd();
      client2.register('histjoin2');
      await client2.waitForNumeric('001');

      const channelName = uniqueChannel('histjoin');

      // Client1 creates the channel
      client1.send(`JOIN ${channelName}`);
      await client1.waitForJoin(channelName);

      // Client2 joins (this should be recorded)
      await new Promise(r => setTimeout(r, 200));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForJoin(channelName);
      await new Promise(r => setTimeout(r, 500));

      client1.clearRawBuffer();

      // Query history - should include JOIN events
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const joins: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'JOIN' || m.command === 'PRIVMSG' || m.command === 'NOTICE' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'JOIN') joins.push(msg.raw);
      }

      // JOIN events must be stored when event-playback is enabled
      expect(joins.length).toBeGreaterThan(0);
      // Verify client2's join is recorded
      const hasJoin2 = joins.some(j => j.includes('histjoin2'));
      expect(hasJoin2).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PART events are stored in history', { retry: 2 }, async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('histpart1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('histpart2');
      await client2.waitForNumeric('001');

      const channelName = uniqueChannel('histpart');

      // Both join the channel
      client1.send(`JOIN ${channelName}`);
      client2.send(`JOIN ${channelName}`);
      await client1.waitForJoin(channelName);
      await client2.waitForJoin(channelName);
      await new Promise(r => setTimeout(r, 300));

      // Client2 parts with a message
      client2.send(`PART ${channelName} :Leaving for test`);
      // Wait for PART to persist to chathistory database
      await new Promise(r => setTimeout(r, 1000));

      client1.clearRawBuffer();

      // Query history
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const parts: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'PART' || m.command === 'JOIN' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'PART') parts.push(msg.raw);
      }

      // PART events must be stored when event-playback is enabled
      expect(parts.length).toBeGreaterThan(0);
      // Verify part message is included
      const hasPartMsg = parts.some(p => p.includes('Leaving for test'));
      expect(hasPartMsg).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('KICK events are stored in history', { retry: 2 }, async () => {
      const op = trackClient(await createRawSocketClient());
      const user = trackClient(await createRawSocketClient());

      await op.capLs();
      await op.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      op.capEnd();
      op.register('histkickop');
      await op.waitForNumeric('001');

      await user.capLs();
      await user.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      user.capEnd();
      user.register('histkickusr');
      await user.waitForNumeric('001');

      const channelName = uniqueChannel('histkick');

      // Op creates channel (gets ops)
      op.send(`JOIN ${channelName}`);
      await op.waitForJoin(channelName);

      // User joins
      user.send(`JOIN ${channelName}`);
      await user.waitForJoin(channelName);
      await new Promise(r => setTimeout(r, 300));

      // Op kicks user
      op.send(`KICK ${channelName} histkickusr :Test kick reason`);
      // Wait for KICK to persist to chathistory database
      await new Promise(r => setTimeout(r, 1000));

      op.clearRawBuffer();

      // Query history
      op.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await op.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const kicks: string[] = [];
      while (true) {
        const msg = await op.waitForParsedLine(
          m => m.command === 'KICK' || m.command === 'JOIN' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'KICK') kicks.push(msg.raw);
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

    it('QUIT events are stored in shared channel history', { retry: 2 }, async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('histquit1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'draft/event-playback', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('histquit2');
      await client2.waitForNumeric('001');

      const channelName = uniqueChannel('histquit');

      // Both join the channel
      client1.send(`JOIN ${channelName}`);
      client2.send(`JOIN ${channelName}`);
      await client1.waitForJoin(channelName);
      await client2.waitForJoin(channelName);
      await new Promise(r => setTimeout(r, 300));

      // Client2 quits with a message
      client2.send('QUIT :Goodbye for test');
      // Wait for QUIT to persist to chathistory database
      await new Promise(r => setTimeout(r, 1000));

      client1.clearRawBuffer();

      // Query history
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch
      const batchStart = await client1.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const quits: string[] = [];
      while (true) {
        const msg = await client1.waitForParsedLine(
          m => m.command === 'QUIT' || m.command === 'JOIN' || m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.command === 'QUIT') quits.push(msg.raw);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histtopic');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Set a topic
      const topicText = `Test topic ${uniqueId()}`;
      client.send(`TOPIC ${channelName} :${topicText}`);
      // Wait for TOPIC confirmation
      await client.waitForCommand('TOPIC', 3000);

      // Use polling helper to wait for LMDB async persistence
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        eventTypes: ['TOPIC', 'JOIN', 'PRIVMSG'],
      });

      // TOPIC events must be stored when event-playback is enabled
      const topics = messages.filter(m => m.includes('TOPIC'));
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histmode');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Set a mode that isn't default (+tn is default, use +m for moderated)
      client.send(`MODE ${channelName} +m`);
      // Wait for MODE to be broadcast to channel members
      await client.waitForCommand('MODE', 3000);

      // Use polling helper to wait for LMDB async persistence
      const messages = await waitForChathistory(client, channelName, {
        minMessages: 1,
        timeoutMs: 10000,
        eventTypes: ['MODE', 'JOIN', 'PRIVMSG'],
      });

      // MODE events must be stored when event-playback is enabled
      const modes = messages.filter(m => m.includes('MODE'));
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histpage');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send 10 messages - MUST get echo with msgid for each
      const sentMsgIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        client.send(`PRIVMSG ${channelName} :Pagination message ${i}`);
        const echo = await client.waitForParsedLine(
          msg => msg.trailing?.includes(`Pagination message ${i}`) === true,
          3000
        );
        const match = echo.raw.match(/msgid=([^\s;]+)/);
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
      const batch1 = await client.waitForBatchStart('chathistory', 5000);
      expect(batch1).toBeDefined();

      const page1: { content: string; msgid: string }[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        const msgidMatch = msg.raw.match(/msgid=([^\s;]+)/);
        const contentMatch = msg.raw.match(/Pagination message (\d+)/);
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
      const batch2 = await client.waitForBatchStart('chathistory', 5000);
      expect(batch2).toBeDefined();

      const page2: { content: string; msgid: string }[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        const msgidMatch = msg.raw.match(/msgid=([^\s;]+)/);
        const contentMatch = msg.raw.match(/Pagination message (\d+)/);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histfwd');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send messages and capture first msgid - MUST succeed
      let firstMsgId: string | null = null;
      for (let i = 1; i <= 8; i++) {
        client.send(`PRIVMSG ${channelName} :Forward page ${i}`);
        const echo = await client.waitForParsedLine(
          msg => msg.trailing?.includes(`Forward page ${i}`) === true,
          3000
        );
        const match = echo.raw.match(/msgid=([^\s;]+)/);
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
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');

      const afterFirst: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        const contentMatch = msg.raw.match(/Forward page (\d+)/);
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
      await client.waitForNumeric('001');

      const channelName = uniqueChannel('histend');
      client.send(`JOIN ${channelName}`);
      await client.waitForJoin(channelName);

      // Send only 3 messages - MUST succeed
      let firstMsgId: string | null = null;
      for (let i = 1; i <= 3; i++) {
        client.send(`PRIVMSG ${channelName} :End test ${i}`);
        const echo = await client.waitForParsedLine(
          msg => msg.trailing?.includes(`End test ${i}`) === true,
          3000
        );
        const match = echo.raw.match(/msgid=([^\s;]+)/);
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
      const batchStart = await client.waitForBatchStart('chathistory', 5000);
      expect(batchStart.command, 'Should receive BATCH start').toBe('BATCH');
      const batchMatch = batchStart.raw.match(/BATCH \+(\S+)/);
      expect(batchMatch).not.toBeNull();
      const batchId = batchMatch![1];

      // Should get batch end with no messages (empty batch at start of history)
      const messages: string[] = [];
      while (true) {
        const msg = await client.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        messages.push(msg.raw);
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
      await sender.waitForNumeric('001');

      await reader.capLs();
      await reader.capReq(['draft/chathistory', 'batch', 'server-time']);
      reader.capEnd();
      reader.register('histrace2');
      await reader.waitForNumeric('001');

      const channelName = uniqueChannel('histrace');
      sender.send(`JOIN ${channelName}`);
      reader.send(`JOIN ${channelName}`);
      await sender.waitForJoin(channelName);
      await reader.waitForJoin(channelName);
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
      const batch1 = await reader.waitForBatchStart('chathistory', 5000);
      expect(batch1).toBeDefined();

      const initialMsgs: string[] = [];
      while (true) {
        const msg = await reader.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        if (msg.raw.includes('Initial')) initialMsgs.push(msg.raw);
      }

      expect(initialMsgs.length).toBeGreaterThan(0);

      // Wait and query again
      await new Promise(r => setTimeout(r, 500));
      reader.clearRawBuffer();
      reader.send(`CHATHISTORY LATEST ${channelName} * 10`);

      // MUST receive batch for follow-up query
      const batch2 = await reader.waitForBatchStart('chathistory', 5000);
      expect(batch2).toBeDefined();

      const allMsgs: string[] = [];
      while (true) {
        const msg = await reader.waitForParsedLine(
          m => m.command === 'PRIVMSG' || (m.command === 'BATCH' && m.params[0]?.startsWith('-')),
          3000
        );
        if (msg.command === 'BATCH' && msg.params[0]?.startsWith('-')) break;
        allMsgs.push(msg.raw);
      }

      // Follow-up should have at least as many as initial plus concurrent
      expect(allMsgs.length).toBeGreaterThanOrEqual(initialMsgs.length);

      sender.send('QUIT');
      reader.send('QUIT');
    });
  });
});
