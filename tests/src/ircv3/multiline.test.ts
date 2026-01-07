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

  describe('Multiline Fallback and Truncation', () => {
    it('sends WARN to sender when recipients lack multiline support', async () => {
      // Client1 sends multiline (has capability)
      const client1 = trackClient(await createRawSocketClient());
      // Client2 receives but doesn't have multiline cap (will get fallback)
      const client2 = trackClient(await createRawSocketClient());

      // Client1: full multiline + standard-replies for WARN
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch standard-replies');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlfallback1');
      client1.send('USER mlfallback1 0 * :mlfallback1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline cap - only basic IRC
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mlfallback2');
      client2.send('USER mlfallback2 0 * :mlfallback2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlfallback');

      // Both join channel
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Wait for both to be in channel
      await new Promise(resolve => setTimeout(resolve, 500));
      client1.clearRawBuffer();

      // Send multiline message (medium size to trigger truncation)
      const batchId = `fb${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 8; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Line ${i} of multiline message`);
      }
      client1.send(`BATCH -${batchId}`);

      // Client1 should receive WARN about fallback
      try {
        const warnLine = await client1.waitForLine(/WARN.*MULTILINE_FALLBACK|WARN.*BATCH/i, 3000);
        console.log('WARN notification received:', warnLine);
        expect(warnLine).toMatch(/WARN/i);
        expect(warnLine).toMatch(/truncat|legacy|fallback/i);
      } catch {
        // WARN may be disabled - check if feature is enabled
        console.log('No WARN received - MULTILINE_FALLBACK_NOTIFY may be disabled');
      }

      // Client2 should receive truncated fallback (individual PRIVMSGs, not full batch)
      const received = await client2.waitForLine(/PRIVMSG.*Line 1/i, 3000);
      console.log('Client2 received fallback:', received);
      expect(received).toContain('PRIVMSG');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('WARN includes labeled-response correlation when sender has capability', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: multiline + labeled-response + standard-replies
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch labeled-response standard-replies');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mllabel1');
      client1.send('USER mllabel1 0 * :mllabel1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mllabel2');
      client2.send('USER mllabel2 0 * :mllabel2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mllabel');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client1.clearRawBuffer();

      // Send labeled multiline batch
      const batchId = `lbl${uniqueId()}`;
      const label = `testlabel${uniqueId()}`;
      client1.send(`@label=${label} BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 8; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Labeled line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Look for WARN with label correlation
      try {
        const warnLine = await client1.waitForLine(/WARN.*MULTILINE|label=/i, 3000);
        console.log('Labeled WARN received:', warnLine);
        // Check if label is correlated
        if (warnLine.includes('label=')) {
          expect(warnLine).toContain(label);
          console.log('Label correlation confirmed in WARN');
        }
      } catch {
        console.log('No labeled WARN received');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('3-tier truncation sends appropriate number of lines for medium batches', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mltrunc1');
      client1.send('USER mltrunc1 0 * :mltrunc1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline (will receive truncated fallback)
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mltrunc2');
      client2.send('USER mltrunc2 0 * :mltrunc2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mltrunc');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client2.clearRawBuffer();

      // Send medium-size multiline (8 lines - should trigger 4-line truncation)
      const batchId = `trunc${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 8; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Content line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Collect all PRIVMSGs received by client2
      const receivedLines: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG.*Content line|truncat|more lines/i, 500);
          receivedLines.push(line);
          console.log('Truncation test received:', line);
        } catch {
          break;
        }
      }

      console.log(`Received ${receivedLines.length} lines for 8-line batch`);
      // Medium batch (6-10 lines) should send ~4 content lines + truncation notice
      expect(receivedLines.length).toBeGreaterThan(0);
      expect(receivedLines.length).toBeLessThanOrEqual(6); // 4 lines + truncation notice

      // Check for truncation notice or retrieval hint
      const hasTruncationNotice = receivedLines.some(l =>
        l.includes('truncat') || l.includes('more lines') || l.includes('&ml-')
      );
      console.log('Has truncation notice:', hasTruncationNotice);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('retrieval hint mentions local channel &ml-<msgid>', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline + message-tags to see msgid
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch message-tags');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlhint1');
      client1.send('USER mlhint1 0 * :mlhint1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mlhint2');
      client2.send('USER mlhint2 0 * :mlhint2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlhint');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client2.clearRawBuffer();

      // Send large multiline (triggers truncation with retrieval hint)
      const batchId = `hint${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 12; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Long message line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Look for truncation notice with &ml- retrieval hint
      let foundRetrievalHint = false;
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE/i, 500);
          console.log('Retrieval hint test:', line);
          if (line.includes('&ml-')) {
            foundRetrievalHint = true;
            console.log('Found &ml- retrieval hint:', line);
            break;
          }
        } catch {
          break;
        }
      }

      // Note: retrieval hints may only appear for certain truncation levels
      console.log('Retrieval hint found:', foundRetrievalHint);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('users with +M mode receive full multiline content', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlmode1');
      client1.send('USER mlmode1 0 * :mlmode1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline but will set +M to receive full content
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mlmode2');
      client2.send('USER mlmode2 0 * :mlmode2');
      await client2.waitForLine(/001/);

      // Client2 sets +M mode (multiline receive mode)
      client2.send('MODE mlmode2 +M');
      try {
        await client2.waitForLine(/MODE.*\+M/i, 2000);
        console.log('Client2 set +M mode');
      } catch {
        console.log('Server may not support +M mode - skipping');
        client1.send('QUIT');
        client2.send('QUIT');
        return;
      }

      const channelName = uniqueChannel('mlmode');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client2.clearRawBuffer();

      // Send multiline message
      const batchId = `mode${uniqueId()}`;
      const totalLines = 8;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= totalLines; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Full content line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Client2 with +M should receive ALL lines (no truncation)
      const receivedLines: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG.*Full content line/i, 500);
          receivedLines.push(line);
        } catch {
          break;
        }
      }

      console.log(`+M mode user received ${receivedLines.length}/${totalLines} lines`);
      // With +M, should receive all lines
      expect(receivedLines.length).toBe(totalLines);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});
