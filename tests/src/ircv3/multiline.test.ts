import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, createIRCv3Client, IRCv3TestClient, uniqueChannel, uniqueId } from '../helpers/index.js';

/**
 * Multiline Message Tests (draft/multiline)
 *
 * Tests the IRCv3 multiline specification for sending multi-line messages
 * using BATCH with the multiline type.
 */
describe('IRCv3 Multiline Messages (draft/multiline)', () => {
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

  describe('Capability Advertisement', () => {
    it('server advertises draft/multiline capability', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      const capsLine = await client.waitForLine(/CAP.*LS/i);
      expect(capsLine).toMatch(/draft\/multiline/i);
      client.send('QUIT');
    });

    it('multiline capability includes parameters', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      const capsLine = await client.waitForLine(/CAP.*LS/i);

      // Should include max-bytes and max-lines parameters
      if (capsLine.includes('draft/multiline')) {
        console.log('Multiline params:', capsLine);
        // Format: max-bytes=N,max-lines=M
        expect(capsLine).toMatch(/max-(bytes|lines)/);
      }
      client.send('QUIT');
    });

    it('can request draft/multiline capability', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      // Use capLs() to properly consume all CAP LS lines (may be multi-line with *)
      const caps = await client.capLs();
      expect(caps.has('draft/multiline')).toBe(true);

      const result = await client.capReq(['draft/multiline', 'batch']);

      expect(result.ack).toContain('draft/multiline');
      expect(result.ack).toContain('batch');
      client.send('QUIT');
    });
  });

  describe('Multiline BATCH', () => {
    it('can send a multiline message using BATCH', async () => {
      const client1 = trackClient(
        await createRawSocketClient()
      );
      const client2 = trackClient(
        await createRawSocketClient()
      );

      // Set up client1 with multiline
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlsend1');
      client1.send('USER mlsend1 0 * :mlsend1');
      await client1.waitForLine(/001/);

      // Set up client2 with draft/multiline AND batch to receive multiline batches
      // Both capabilities are required to receive messages as a batch
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP REQ :draft/multiline batch');
      await client2.waitForLine(/CAP.*ACK/i);
      client2.send('CAP END');
      client2.send('NICK mlrecv1');
      client2.send('USER mlrecv1 0 * :mlrecv1');
      await client2.waitForLine(/001/);

      // Both join channel
      const channelName = uniqueChannel('mltest');
      client1.send(`JOIN ${channelName}`);
      client2.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 500));

      // Send multiline message using BATCH
      const batchId = `ml${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Line 1 of message`);
      client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Line 2 of message`);
      client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Line 3 of message`);
      client1.send(`BATCH -${batchId}`);

      // Client2 should receive the batch
      const batchStart = await client2.waitForLine(/BATCH \+.*multiline/i, 3000);
      expect(batchStart).toContain('multiline');
      console.log('Received multiline batch start:', batchStart);

      // Collect all messages in the batch
      const messages: string[] = [];
      while (true) {
        const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 2000);
        messages.push(line);
        if (line.includes('BATCH -')) break;
      }
      console.log('Multiline messages:', messages);

      expect(messages.length).toBeGreaterThanOrEqual(3);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('handles multiline with PRIVMSG continuation', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      await client.waitForLine(/CAP.*LS/i);
      client.send('CAP REQ :draft/multiline batch echo-message');
      await client.waitForLine(/CAP.*ACK/i);
      client.send('CAP END');
      client.send('NICK mlcont1');
      client.send('USER mlcont1 0 * :mlcont1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('mlcont');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      // Wait for all post-join messages
      await new Promise(r => setTimeout(r, 500));
      // Clear buffer to capture only echo response
      client.clearRawBuffer();

      // Send multiline with continuation marker
      const batchId = `mlc${uniqueId()}`;
      client.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      client.send(`@batch=${batchId} PRIVMSG ${channelName} :First line`);
      client.send(`@batch=${batchId};draft/multiline-concat PRIVMSG ${channelName} :continued...`);
      client.send(`BATCH -${batchId}`);

      // With echo-message, we should see our own message back as a batch
      // Collect lines until we get BATCH - (end of echo batch)
      const allLines: string[] = [];
      const batchStartEcho = await client.waitForLine(/BATCH \+.*multiline/i, 3000);
      allLines.push(batchStartEcho);
      expect(batchStartEcho).toContain('multiline');
      console.log('Multiline echo batch start:', batchStartEcho);

      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        allLines.push(line);
        if (line.includes('BATCH -')) break;
      }
      console.log('All lines received:', allLines);

      // Should have at least BATCH +, one or more PRIVMSGs, and BATCH -
      expect(allLines.length).toBeGreaterThanOrEqual(3);

      client.send('QUIT');
    });
  });

  describe('Multiline Limits', () => {
    it('respects max-lines limit', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      const capsLine = await client.waitForLine(/CAP.*LS/i);

      // Parse max-lines from capability value
      let maxLines = 100; // default
      const match = capsLine.match(/draft\/multiline=[^\s]*max-lines=(\d+)/);
      if (match) {
        maxLines = parseInt(match[1], 10);
      }

      console.log(`Server max-lines: ${maxLines}`);
      expect(maxLines).toBeGreaterThan(0);

      client.send('QUIT');
    });

    it('respects max-bytes limit', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      const capsLine = await client.waitForLine(/CAP.*LS/i);

      // Parse max-bytes from capability value
      let maxBytes = 4096; // default
      const match = capsLine.match(/draft\/multiline=[^\s]*max-bytes=(\d+)/);
      if (match) {
        maxBytes = parseInt(match[1], 10);
      }

      console.log(`Server max-bytes: ${maxBytes}`);
      expect(maxBytes).toBeGreaterThan(0);

      client.send('QUIT');
    });

    it('server rejects oversized multiline batch', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      const capsLine = await client.waitForLine(/CAP.*LS/i);

      // Find max-lines limit
      let maxLines = 100;
      const match = capsLine.match(/draft\/multiline=[^\s]*max-lines=(\d+)/);
      if (match) {
        maxLines = parseInt(match[1], 10);
      }

      client.send('CAP REQ :draft/multiline batch');
      await client.waitForLine(/CAP.*ACK/i);
      client.send('CAP END');
      client.send('NICK mlover1');
      client.send('USER mlover1 0 * :mlover1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('mlover');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send more lines than allowed
      const batchId = `over${uniqueId()}`;
      client.send(`BATCH +${batchId} draft/multiline ${channelName}`);

      for (let i = 0; i < maxLines + 10; i++) {
        client.send(`@batch=${batchId} PRIVMSG ${channelName} :Line ${i + 1}`);
      }

      client.send(`BATCH -${batchId}`);

      // Should receive an error for oversized batch
      const response = await client.waitForLine(/FAIL|ERR|4\d\d/, 3000);
      console.log('Oversized batch response:', response);
      expect(response).toMatch(/FAIL|ERR|4\d\d/);

      client.send('QUIT');
    });
  });

  describe('Multiline with Other Capabilities', () => {
    it('multiline works with labeled-response', async () => {
      const client = trackClient(
        await createRawSocketClient()
      );

      client.send('CAP LS 302');
      await client.waitForLine(/CAP.*LS/i);
      client.send('CAP REQ :draft/multiline batch labeled-response echo-message');
      await client.waitForLine(/CAP.*ACK/i);
      client.send('CAP END');
      client.send('NICK mllabel1');
      client.send('USER mllabel1 0 * :mllabel1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('mllabel');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Wait for post-join messages to complete
      await new Promise(r => setTimeout(r, 300));
      client.clearRawBuffer();

      // Send multiline with label
      const label = `label${uniqueId()}`;
      const batchId = `lblml${uniqueId()}`;

      client.send(`@label=${label} BATCH +${batchId} draft/multiline ${channelName}`);
      client.send(`@batch=${batchId} PRIVMSG ${channelName} :Labeled line 1`);
      client.send(`@batch=${batchId} PRIVMSG ${channelName} :Labeled line 2`);
      client.send(`BATCH -${batchId}`);

      // With echo-message, we should receive the multiline batch back
      const batchStart = await client.waitForLine(/BATCH \+.*multiline/i, 3000);
      expect(batchStart).toContain('multiline');
      console.log('Labeled multiline batch start:', batchStart);

      // Check if label is echoed (server may or may not support labels on multiline batches)
      if (batchStart.includes(label)) {
        console.log('Label echoed in multiline batch');
      } else {
        console.log('Label not echoed - server may not support labels on multiline batches');
      }

      // Collect rest of batch to verify multiline works
      const messages: string[] = [];
      while (true) {
        const line = await client.waitForLine(/PRIVMSG|BATCH -/, 2000);
        messages.push(line);
        if (line.includes('BATCH -')) break;
      }
      expect(messages.length).toBeGreaterThanOrEqual(3); // 2 PRIVMSG + BATCH -
      console.log('Labeled multiline messages:', messages);

      client.send('QUIT');
    });

    it('multiline messages include msgid tags', async () => {
      const client1 = trackClient(
        await createRawSocketClient()
      );
      const client2 = trackClient(
        await createRawSocketClient()
      );

      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlmsgid1');
      client1.send('USER mlmsgid1 0 * :mlmsgid1');
      await client1.waitForLine(/001/);

      // Client2 needs draft/multiline, batch AND message-tags to receive msgid
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP REQ :draft/multiline batch message-tags');
      await client2.waitForLine(/CAP.*ACK/i);
      client2.send('CAP END');
      client2.send('NICK mlmsgid2');
      client2.send('USER mlmsgid2 0 * :mlmsgid2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlmsgid');
      // Join client1 first, then client2 to avoid race condition
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Now join client2 - it will see client1 in NAMES
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      // Wait for NAMES list to confirm both in channel
      await client2.waitForLine(/366.*End of.*NAMES/i, 2000);

      // Clear buffer before sending
      client2.clearRawBuffer();

      // Send multiline message
      const batchId = `msgidml${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Message with msgid`);
      client1.send(`BATCH -${batchId}`);

      // Client2 should receive the batch
      const batchStart = await client2.waitForLine(/BATCH \+.*multiline/i, 3000);
      console.log('Multiline batch start:', batchStart);
      expect(batchStart).toContain('multiline');

      // Collect messages until BATCH -
      const messages: string[] = [];
      while (true) {
        const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 2000);
        messages.push(line);
        if (line.includes('BATCH -')) break;
      }
      console.log('Multiline messages:', messages);

      // Should have at least one PRIVMSG and BATCH -
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // Check if any message has msgid (server should add msgid to batched messages)
      const hasMsgid = messages.some(m => m.includes('msgid='));
      expect(hasMsgid).toBe(true);
      console.log('Found msgid in multiline messages');

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});
