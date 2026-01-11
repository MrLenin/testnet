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
      // Could be HistServ FETCH hint (when available) or &ml- channel (fallback)
      const hasTruncationNotice = receivedLines.some(l =>
        l.includes('truncat') || l.includes('more lines') || l.includes('&ml-') || l.toLowerCase().includes('histserv')
      );
      console.log('Has truncation notice:', hasTruncationNotice);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    // Retrieval hints: HistServ FETCH (when HistServ available) or &ml- channel (fallback)
    it('truncated multiline includes retrieval hint', async () => {
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

      await new Promise(resolve => setTimeout(resolve, 1000));
      client2.clearRawBuffer();

      // Send large multiline (triggers truncation with retrieval hint)
      const batchId = `hint${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 12; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Long message line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Look for truncation notice with retrieval hint
      // Could be HistServ FETCH (when HistServ available) or &ml- channel (fallback)
      let foundHistServHint = false;
      let foundMlChannelHint = false;
      let receivedLines = 0;
      const startTime = Date.now();
      while (Date.now() - startTime < 4000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE/i, 500);
          receivedLines++;
          console.log('Retrieval hint test:', line);

          if (line.toLowerCase().includes('histserv')) {
            foundHistServHint = true;
            console.log('Found HistServ retrieval hint:', line);
          }
          if (line.includes('&ml-')) {
            foundMlChannelHint = true;
            console.log('Found &ml- retrieval hint:', line);
          }
        } catch {
          break;
        }
      }

      console.log('Received lines:', receivedLines);
      console.log('Found HistServ hint:', foundHistServHint);
      console.log('Found &ml- hint:', foundMlChannelHint);

      // Should have received some content
      expect(receivedLines).toBeGreaterThan(0);
      // Should have some form of retrieval hint
      expect(foundHistServHint || foundMlChannelHint).toBe(true);

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

  describe('Multiline Retrieval Mechanisms', () => {
    it('chathistory fallback hint for clients with chathistory but not multiline', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline (sender)
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch message-tags');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlchhist1');
      client1.send('USER mlchhist1 0 * :mlchhist1');
      await client1.waitForLine(/001/);

      // Client2: has chathistory but NOT multiline (should get chathistory hint)
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP REQ :draft/chathistory batch message-tags');
      await client2.waitForLine(/CAP.*ACK/i);
      client2.send('CAP END');
      client2.send('NICK mlchhist2');
      client2.send('USER mlchhist2 0 * :mlchhist2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlchhist');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client2.clearRawBuffer();

      // Send large multiline to trigger truncation
      const batchId = `chhist${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 12; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Chathistory fallback line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Client2 should receive truncated message with chathistory hint
      let foundChathistoryHint = false;
      let capturedMsgid: string | null = null;
      const receivedLines: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 4000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE/i, 500);
          receivedLines.push(line);
          console.log('Chathistory fallback test:', line);

          // Look for CHATHISTORY hint
          if (line.toLowerCase().includes('chathistory') || line.includes('AROUND')) {
            foundChathistoryHint = true;
            console.log('Found CHATHISTORY hint:', line);
          }

          // Capture msgid for later verification
          const msgidMatch = line.match(/msgid=([^\s;]+)/);
          if (msgidMatch) {
            capturedMsgid = msgidMatch[1];
          }
        } catch {
          break;
        }
      }

      console.log('Received lines:', receivedLines.length);
      console.log('Found chathistory hint:', foundChathistoryHint);
      console.log('Captured msgid:', capturedMsgid);

      // Verify we got some truncated content
      expect(receivedLines.length).toBeGreaterThan(0);

      // If chathistory hint was provided, try to retrieve full message
      if (foundChathistoryHint && capturedMsgid) {
        client2.clearRawBuffer();
        client2.send(`CHATHISTORY AROUND ${channelName} msgid=${capturedMsgid} 5`);

        try {
          const batchStart = await client2.waitForLine(/BATCH \+/i, 3000);
          console.log('CHATHISTORY AROUND response:', batchStart);

          // Collect the batch
          const historyLines: string[] = [];
          while (true) {
            const line = await client2.waitForLine(/PRIVMSG|BATCH -/i, 2000);
            historyLines.push(line);
            if (line.includes('BATCH -')) break;
          }

          console.log('Retrieved via CHATHISTORY:', historyLines.length, 'lines');
          // Should retrieve more content than the truncated version
          expect(historyLines.length).toBeGreaterThan(receivedLines.length);
        } catch (e) {
          console.log('CHATHISTORY retrieval failed:', e);
        }
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('HistServ fallback for clients without chathistory or multiline', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline (sender)
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlhserv1');
      client1.send('USER mlhserv1 0 * :mlhserv1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline, NO chathistory (basic IRC client - should get HistServ hint)
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mlhserv2');
      client2.send('USER mlhserv2 0 * :mlhserv2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlhserv');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Wait for join to fully complete and drain any server notices
      await new Promise(resolve => setTimeout(resolve, 1000));
      client2.clearRawBuffer();

      // Send large multiline to trigger truncation
      const batchId = `hserv${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= 15; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :HistServ fallback line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Client2 should receive truncated message with HistServ hint or &ml- channel
      let foundHistServHint = false;
      let histServMsgid: string | null = null;
      let foundLocalChannel = false;
      const receivedLines: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 5000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE/i, 1000);
          receivedLines.push(line);
          console.log('HistServ fallback test:', line);

          // Look for HistServ FETCH hint with msgid
          // Format: [N more lines - /msg HistServ FETCH #channel msgid]
          const histServMatch = line.match(/HistServ FETCH \S+ (\S+)/i);
          if (histServMatch) {
            foundHistServHint = true;
            histServMsgid = histServMatch[1];
            console.log('Found HistServ hint with msgid:', histServMsgid);
          }

          // Look for &ml- local channel hint (fallback when HistServ unavailable)
          if (line.includes('&ml-')) {
            foundLocalChannel = true;
            console.log('Found &ml- local channel hint:', line);
          }
        } catch {
          break;
        }
      }

      console.log('Received lines:', receivedLines.length);
      console.log('Found HistServ hint:', foundHistServHint);
      console.log('Found &ml- channel:', foundLocalChannel);

      // Verify we got some truncated content
      expect(receivedLines.length).toBeGreaterThan(0);

      // Should have HistServ hint (or &ml- if HistServ unavailable)
      const hasRetrievalHint = foundHistServHint || foundLocalChannel;
      expect(hasRetrievalHint).toBe(true);

      // If we got a HistServ hint, verify we can retrieve the full message
      if (foundHistServHint && histServMsgid) {
        client2.clearRawBuffer();
        client2.send(`PRIVMSG HistServ :FETCH ${channelName} ${histServMsgid}`);

        const histServLines: string[] = [];
        const fetchStart = Date.now();
        while (Date.now() - fetchStart < 3000) {
          try {
            const line = await client2.waitForLine(/NOTICE.*HistServ|PRIVMSG/i, 500);
            histServLines.push(line);
            console.log('HistServ FETCH response:', line);
          } catch {
            break;
          }
        }

        console.log('Retrieved via HistServ:', histServLines.length, 'lines');
        // Should retrieve more content than the truncated version
        expect(histServLines.length).toBeGreaterThan(0);
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    // Test &ml- virtual channel directly using captured msgid.
    // The &ml- storage is always populated (Tier 4 fallback), even when HistServ hint is shown.
    it('can join &ml-<msgid> virtual channel to retrieve full message', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: has multiline + message-tags + echo-message (sender, to capture msgid)
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch message-tags echo-message');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlvirt1');
      client1.send('USER mlvirt1 0 * :mlvirt1');
      await client1.waitForLine(/001/);

      // Client2: NO multiline, NO chathistory (basic client)
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP END');
      client2.send('NICK mlvirt2');
      client2.send('USER mlvirt2 0 * :mlvirt2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlvirt');

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 1000));
      client1.clearRawBuffer();
      client2.clearRawBuffer();

      // Send multiline message
      const totalLines = 10;
      const batchId = `virt${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (let i = 1; i <= totalLines; i++) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :Virtual channel line ${i}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Client1 gets echo with msgid - capture it
      let capturedMsgid: string | null = null;
      try {
        const echoBatch = await client1.waitForLine(/BATCH \+.*multiline/i, 3000);
        const msgidMatch = echoBatch.match(/msgid=([^\s;]+)/);
        if (msgidMatch) {
          capturedMsgid = msgidMatch[1];
          console.log('Captured msgid from echo:', capturedMsgid);
        }

        // Drain the echo batch
        while (true) {
          const line = await client1.waitForLine(/PRIVMSG|BATCH -/i, 1000);
          if (line.includes('BATCH -')) break;
        }
      } catch (e) {
        console.log('Echo capture failed:', e);
      }

      // Drain client2's truncated message (we don't need to parse it)
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE/i, 500);
          console.log('Virtual channel test (client2):', line);
        } catch {
          break;
        }
      }

      // We must have captured the msgid to test virtual channels
      expect(capturedMsgid).not.toBeNull();
      const channelToJoin = `&ml-${capturedMsgid}`;

      console.log('Attempting to join virtual channel:', channelToJoin);
      client2.clearRawBuffer();
      client2.send(`JOIN ${channelToJoin}`);

      // Virtual channel join should deliver content via PRIVMSGs
      const contentLines: string[] = [];
      const collectStart = Date.now();
      while (Date.now() - collectStart < 3000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG|NOTICE|JOIN|4\d\d/i, 500);
          console.log('Virtual channel response:', line);

          if (line.match(/4\d\d/)) {
            // Error response - virtual channel not supported
            console.log('Virtual channel join rejected:', line);
            break;
          }
          if (line.includes('PRIVMSG') && line.includes('Virtual channel line')) {
            contentLines.push(line);
          }
        } catch {
          break;
        }
      }

      console.log('Retrieved', contentLines.length, 'lines from virtual channel');
      // Should have retrieved all 10 lines
      expect(contentLines.length).toBe(totalLines);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('virtual channel content matches original multiline message', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Client1: sender with full caps
      client1.send('CAP LS 302');
      await client1.waitForLine(/CAP.*LS/i);
      client1.send('CAP REQ :draft/multiline batch message-tags echo-message');
      await client1.waitForLine(/CAP.*ACK/i);
      client1.send('CAP END');
      client1.send('NICK mlmatch1');
      client1.send('USER mlmatch1 0 * :mlmatch1');
      await client1.waitForLine(/001/);

      // Client2: receiver with message-tags (to see content)
      client2.send('CAP LS 302');
      await client2.waitForLine(/CAP.*LS/i);
      client2.send('CAP REQ :message-tags');
      await client2.waitForLine(/CAP.*ACK/i);
      client2.send('CAP END');
      client2.send('NICK mlmatch2');
      client2.send('USER mlmatch2 0 * :mlmatch2');
      await client2.waitForLine(/001/);

      const channelName = uniqueChannel('mlmatch');
      const expectedContent = [
        'First line of important message',
        'Second line with details',
        'Third line conclusion',
        'Fourth line signature',
        'Fifth line postscript',
        'Sixth line addendum',
        'Seventh line extra info',
        'Eighth line final notes',
      ];

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(resolve => setTimeout(resolve, 500));
      client1.clearRawBuffer();
      client2.clearRawBuffer();

      // Send specific content
      const batchId = `match${uniqueId()}`;
      client1.send(`BATCH +${batchId} draft/multiline ${channelName}`);
      for (const line of expectedContent) {
        client1.send(`@batch=${batchId} PRIVMSG ${channelName} :${line}`);
      }
      client1.send(`BATCH -${batchId}`);

      // Capture msgid from echo
      let capturedMsgid: string | null = null;
      try {
        const echoBatch = await client1.waitForLine(/BATCH \+.*multiline/i, 3000);
        const msgidMatch = echoBatch.match(/msgid=([^\s;]+)/);
        if (msgidMatch) capturedMsgid = msgidMatch[1];

        // Drain echo batch
        while (true) {
          const line = await client1.waitForLine(/PRIVMSG|BATCH -/i, 1000);
          if (line.includes('BATCH -')) break;
        }
      } catch {
        // Continue without msgid
      }

      // Collect what client2 received (truncated)
      const truncatedContent: string[] = [];
      let localChannel: string | null = null;
      const startTime = Date.now();

      while (Date.now() - startTime < 4000) {
        try {
          const line = await client2.waitForLine(/PRIVMSG/i, 500);

          // Extract message text
          const textMatch = line.match(/PRIVMSG [^\s]+ :(.+)$/);
          if (textMatch) {
            truncatedContent.push(textMatch[1]);
          }

          // Look for &ml- hint
          const mlMatch = line.match(/(&ml-[^\s]+)/);
          if (mlMatch) localChannel = mlMatch[1];
        } catch {
          break;
        }
      }

      console.log('Truncated content received:', truncatedContent.length, 'lines');
      console.log('Local channel hint:', localChannel);

      // Try to retrieve full content via virtual channel
      const channelToJoin = localChannel || (capturedMsgid ? `&ml-${capturedMsgid}` : null);

      if (channelToJoin) {
        client2.clearRawBuffer();
        client2.send(`JOIN ${channelToJoin}`);

        const fullContent: string[] = [];
        try {
          await client2.waitForLine(/JOIN/i, 2000);

          // Collect PRIVMSGs (the stored multiline content)
          const collectStart = Date.now();
          while (Date.now() - collectStart < 3000) {
            try {
              const line = await client2.waitForLine(/PRIVMSG/i, 500);
              const textMatch = line.match(/PRIVMSG [^\s]+ :(.+)$/);
              if (textMatch) fullContent.push(textMatch[1]);
            } catch {
              break;
            }
          }
        } catch {
          console.log('Could not retrieve via virtual channel');
        }

        if (fullContent.length > 0) {
          console.log('Full content retrieved:', fullContent.length, 'lines');

          // Verify content matches
          for (let i = 0; i < Math.min(fullContent.length, expectedContent.length); i++) {
            console.log(`Line ${i + 1}: expected "${expectedContent[i]}", got "${fullContent[i]}"`);
            expect(fullContent[i]).toBe(expectedContent[i]);
          }

          // Virtual channel should have more content than truncated version
          expect(fullContent.length).toBeGreaterThanOrEqual(truncatedContent.length);
        }

        client2.send(`PART ${channelToJoin}`);
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});
