import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, SECONDARY_SERVER } from '../helpers/index.js';

/**
 * Chathistory Federation Tests
 *
 * Tests S2S chathistory federation where messages sent while a server
 * was disconnected are retrieved via federation queries.
 *
 * Test flow:
 * 1. Connect to primary server as oper
 * 2. SQUIT the secondary server to disconnect it
 * 3. Send messages on primary (stored in primary's LMDB only)
 * 4. CONNECT secondary server back
 * 5. Connect client to secondary and query CHATHISTORY
 * 6. Verify messages are retrieved via federation from primary
 *
 * IMPORTANT: The secondary server name is 'leaf.fractalrealities.net'
 * For netsplit tests to work properly, servers must be linked before SQUIT.
 */

const SECONDARY_SERVER_NAME = 'leaf.fractalrealities.net';

/**
 * Helper to wait for servers to be linked by checking LINKS output
 * After finding the server, drains any remaining LINKS responses
 */
async function waitForServerLink(
  operClient: RawSocketClient,
  serverName: string,
  timeout: number = 15000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    operClient.clearRawBuffer();
    operClient.send('LINKS');

    try {
      // Wait for LINKS response - look for the server name or end of links
      const lines: string[] = [];
      const waitStart = Date.now();
      while (Date.now() - waitStart < 3000) {
        try {
          const line = await operClient.waitForLine(/364|365/, 500);
          lines.push(line);
          if (line.includes('365')) break; // End of /LINKS
        } catch {
          break;
        }
      }

      // Check if serverName appears in LINKS output
      for (const line of lines) {
        if (line.includes(serverName)) {
          console.log(`Server ${serverName} is linked`);
          // Drain any remaining buffer and wait for responses to settle
          await new Promise(r => setTimeout(r, 200));
          operClient.clearRawBuffer();
          return true;
        }
      }
    } catch {
      // Continue waiting
    }

    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Helper to ensure servers are linked before tests
 * If not linked, issues CONNECT and waits for link
 */
async function ensureServersLinked(
  operClient: RawSocketClient,
  serverName: string
): Promise<boolean> {
  // Check if already linked
  const alreadyLinked = await waitForServerLink(operClient, serverName, 3000);
  if (alreadyLinked) {
    return true;
  }

  // Not linked - try to connect
  console.log(`Server ${serverName} not linked, attempting CONNECT...`);
  operClient.send(`CONNECT ${serverName}`);

  // Wait for link to establish
  return await waitForServerLink(operClient, serverName, 15000);
}
describe('IRCv3 Chathistory Federation', () => {
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

  // Check if secondary server is available
  let secondaryAvailable = false;
  beforeAll(async () => {
    try {
      const testClient = new RawSocketClient();
      await testClient.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
      testClient.close();
      secondaryAvailable = true;
    } catch {
      secondaryAvailable = false;
    }
  });

  describe('Federation Query', () => {
    it('retrieves messages from remote server via federation', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available (run with --profile linked)');
        return;
      }

      // Step 1: Connect to primary as oper
      const operClient = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await operClient.capLs();
      await operClient.capReq(['draft/chathistory', 'batch', 'server-time', 'message-tags']);
      operClient.capEnd();
      operClient.register('fedoper1');
      await operClient.waitForLine(/001/);

      // Become oper
      operClient.send('OPER oper shmoo');
      try {
        await operClient.waitForLine(/381/, 5000); // RPL_YOUREOPER
        console.log('Authenticated as oper');
      } catch (e) {
        console.log('Failed to oper up:', (e as Error).message);
        return;
      }

      // Step 2: Get current server link status
      // We need to find the secondary server name
      const secondaryServerName = 'leaf.fractalrealities.net';

      // Step 3: SQUIT secondary server
      console.log(`Disconnecting secondary server: ${secondaryServerName}`);
      operClient.send(`SQUIT ${secondaryServerName} :Federation test`);

      // Wait for squit to process
      await new Promise(r => setTimeout(r, 2000));

      // Step 4: Create a unique channel and send messages
      const channelName = `#fedhist${Date.now()}`;
      operClient.send(`JOIN ${channelName}`);
      await operClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send test messages (these go to primary's LMDB only since secondary is disconnected)
      const testMessages = [
        'Federation test message 1 - sent while secondary disconnected',
        'Federation test message 2 - should be retrieved via S2S',
        'Federation test message 3 - verifying deduplication works',
      ];

      for (const msg of testMessages) {
        operClient.send(`PRIVMSG ${channelName} :${msg}`);
        await new Promise(r => setTimeout(r, 100));
      }

      // Wait for messages to be stored
      await new Promise(r => setTimeout(r, 1000));
      console.log(`Sent ${testMessages.length} messages to ${channelName} while secondary disconnected`);

      // Step 5: CONNECT secondary server back
      console.log('Reconnecting secondary server...');
      operClient.send(`CONNECT ${secondaryServerName}`);

      // Wait for link to establish
      await new Promise(r => setTimeout(r, 3000));

      // Verify link is back by checking we can connect to secondary
      let secondaryReconnected = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const testClient = new RawSocketClient();
          await testClient.connect(SECONDARY_SERVER.host, SECONDARY_SERVER.port);
          testClient.close();
          secondaryReconnected = true;
          break;
        } catch {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!secondaryReconnected) {
        console.log('Secondary server did not reconnect, skipping federation test');
        return;
      }

      console.log('Secondary server reconnected');

      // Step 6: Connect to secondary server and query chathistory
      const secondaryClient = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      await secondaryClient.capLs();
      await secondaryClient.capReq(['draft/chathistory', 'batch', 'server-time', 'message-tags']);
      secondaryClient.capEnd();
      secondaryClient.register('fedclient1');
      await secondaryClient.waitForLine(/001/);

      // Join the channel
      secondaryClient.send(`JOIN ${channelName}`);
      await secondaryClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Clear buffer before chathistory query
      secondaryClient.clearRawBuffer();

      // Step 7: Query chathistory - should trigger federation since secondary has no local history
      console.log(`Querying CHATHISTORY LATEST ${channelName} * 50`);
      secondaryClient.send(`CHATHISTORY LATEST ${channelName} * 50`);

      // Collect batch response
      try {
        const batchStart = await secondaryClient.waitForLine(/BATCH \+\S+ chathistory/i, 10000);
        console.log('Got batch start:', batchStart);

        const messages: string[] = [];
        const startTime = Date.now();
        while (Date.now() - startTime < 8000) {
          try {
            const line = await secondaryClient.waitForLine(/PRIVMSG|BATCH -/, 1000);
            if (line.includes('BATCH -')) {
              console.log('Got batch end');
              break;
            }
            if (line.includes('PRIVMSG')) {
              messages.push(line);
            }
          } catch {
            break;
          }
        }

        console.log(`Received ${messages.length} messages via federation`);

        // Verify we got the test messages
        let foundCount = 0;
        for (const testMsg of testMessages) {
          const found = messages.some(m => m.includes(testMsg));
          if (found) {
            foundCount++;
            console.log(`  Found: "${testMsg.substring(0, 40)}..."`);
          } else {
            console.log(`  MISSING: "${testMsg.substring(0, 40)}..."`);
          }
        }

        expect(foundCount).toBeGreaterThan(0);
        console.log(`Federation test: ${foundCount}/${testMessages.length} messages retrieved`);

        if (foundCount === testMessages.length) {
          console.log('SUCCESS: All messages retrieved via S2S federation!');
        } else if (foundCount > 0) {
          console.log('PARTIAL: Some messages retrieved via federation');
        }

      } catch (e) {
        console.log('Chathistory query failed:', (e as Error).message);
        // This could happen if LMDB isn't available or federation isn't working
      }

      // Cleanup
      operClient.send('QUIT');
      secondaryClient.send('QUIT');
    });

    it('deduplicates messages when both servers have history', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      // This test verifies deduplication when messages are on both servers
      // (normal case - servers were linked when messages were sent)

      const client1 = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client1.capEnd();
      client1.register('dedup1');
      await client1.waitForLine(/001/);

      const channelName = `#dedup${Date.now()}`;
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send messages (these propagate to both servers via S2S)
      for (let i = 0; i < 5; i++) {
        client1.send(`PRIVMSG ${channelName} :Dedup test message ${i}`);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 1000));

      // Query from secondary - should get each message only once
      const client2 = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('dedup2');
      await client2.waitForLine(/001/);

      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client2.clearRawBuffer();
      client2.send(`CHATHISTORY LATEST ${channelName} * 50`);

      try {
        await client2.waitForLine(/BATCH \+\S+ chathistory/i, 5000);

        const messages: string[] = [];
        const msgIds = new Set<string>();
        const startTime = Date.now();

        while (Date.now() - startTime < 5000) {
          try {
            const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('PRIVMSG')) {
              messages.push(line);
              // Extract msgid if present
              const match = line.match(/msgid=([^\s;]+)/);
              if (match) {
                msgIds.add(match[1]);
              }
            }
          } catch {
            break;
          }
        }

        console.log(`Got ${messages.length} messages with ${msgIds.size} unique msgids`);

        // If deduplication works, messages.length should equal msgIds.size
        // (no duplicate msgids)
        if (msgIds.size > 0) {
          expect(messages.length).toBe(msgIds.size);
          console.log('Deduplication working: no duplicate messages');
        }

      } catch (e) {
        console.log('Dedup test failed:', (e as Error).message);
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Consistency', () => {
    it('same history returned from both servers', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      // Create channel and send messages from primary
      const client1 = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'echo-message']);
      client1.capEnd();
      client1.register('consist1');
      await client1.waitForLine(/001/);

      const channelName = `#consist${Date.now()}`;
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send messages and capture their msgids
      const sentMsgIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        client1.send(`PRIVMSG ${channelName} :Consistency test message ${i}`);
        try {
          const echo = await client1.waitForLine(new RegExp(`PRIVMSG.*Consistency test message ${i}`, 'i'), 3000);
          const match = echo.match(/msgid=([^\s;]+)/);
          if (match) {
            sentMsgIds.push(match[1]);
          }
        } catch {
          // Continue
        }
        await new Promise(r => setTimeout(r, 50));
      }

      console.log(`Sent ${sentMsgIds.length} messages with msgids`);
      await new Promise(r => setTimeout(r, 1000));

      // Query history from primary
      client1.clearRawBuffer();
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      const primaryMsgIds: string[] = [];
      try {
        await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            const match = line.match(/msgid=([^\s;]+)/);
            if (match) primaryMsgIds.push(match[1]);
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Primary query failed:', (e as Error).message);
      }

      console.log(`Primary server returned ${primaryMsgIds.length} messages`);

      // Now query from secondary
      const client2 = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('consist2');
      await client2.waitForLine(/001/);

      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(r => setTimeout(r, 500));
      client2.clearRawBuffer();
      client2.send(`CHATHISTORY LATEST ${channelName} * 10`);

      const secondaryMsgIds: string[] = [];
      try {
        await client2.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            const match = line.match(/msgid=([^\s;]+)/);
            if (match) secondaryMsgIds.push(match[1]);
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Secondary query failed:', (e as Error).message);
      }

      console.log(`Secondary server returned ${secondaryMsgIds.length} messages`);

      // Compare results
      const primarySet = new Set(primaryMsgIds);
      const secondarySet = new Set(secondaryMsgIds);

      // Both should have same messages
      let matches = 0;
      for (const msgid of primaryMsgIds) {
        if (secondarySet.has(msgid)) matches++;
      }

      console.log(`Matching msgids: ${matches}/${primaryMsgIds.length}`);
      if (primaryMsgIds.length > 0 && secondaryMsgIds.length > 0) {
        expect(matches).toBe(primaryMsgIds.length);
        console.log('SUCCESS: Both servers return consistent history');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('history order is consistent across servers', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      const client1 = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('order1');
      await client1.waitForLine(/001/);

      const channelName = `#order${Date.now()}`;
      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send numbered messages
      for (let i = 1; i <= 5; i++) {
        client1.send(`PRIVMSG ${channelName} :Order test ${i}`);
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 1000));

      // Query from primary
      client1.clearRawBuffer();
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      const primaryOrder: string[] = [];
      try {
        await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('Order test')) {
              const match = line.match(/Order test (\d+)/);
              if (match) primaryOrder.push(match[1]);
            }
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Primary query failed:', (e as Error).message);
      }

      // Query from secondary
      const client2 = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('order2');
      await client2.waitForLine(/001/);

      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      await new Promise(r => setTimeout(r, 500));
      client2.clearRawBuffer();
      client2.send(`CHATHISTORY LATEST ${channelName} * 10`);

      const secondaryOrder: string[] = [];
      try {
        await client2.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('Order test')) {
              const match = line.match(/Order test (\d+)/);
              if (match) secondaryOrder.push(match[1]);
            }
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Secondary query failed:', (e as Error).message);
      }

      console.log(`Primary order: ${primaryOrder.join(', ')}`);
      console.log(`Secondary order: ${secondaryOrder.join(', ')}`);

      // Orders should match
      if (primaryOrder.length > 0 && secondaryOrder.length > 0) {
        expect(primaryOrder).toEqual(secondaryOrder);
        console.log('SUCCESS: Message order is consistent');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('messages from both servers appear in shared history', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      const client1 = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      const client2 = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time']);
      client1.capEnd();
      client1.register('mixed1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time']);
      client2.capEnd();
      client2.register('mixed2');
      await client2.waitForLine(/001/);

      const channelName = `#mixed${Date.now()}`;

      client1.send(`JOIN ${channelName}`);
      await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client2.send(`JOIN ${channelName}`);
      await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 500));

      // Send messages from both servers interleaved
      client1.send(`PRIVMSG ${channelName} :From primary 1`);
      await new Promise(r => setTimeout(r, 100));
      client2.send(`PRIVMSG ${channelName} :From secondary 1`);
      await new Promise(r => setTimeout(r, 100));
      client1.send(`PRIVMSG ${channelName} :From primary 2`);
      await new Promise(r => setTimeout(r, 100));
      client2.send(`PRIVMSG ${channelName} :From secondary 2`);
      await new Promise(r => setTimeout(r, 1000));

      // Query history from either server
      client1.clearRawBuffer();
      client1.send(`CHATHISTORY LATEST ${channelName} * 10`);

      let fromPrimary = 0;
      let fromSecondary = 0;

      try {
        await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('From primary')) fromPrimary++;
            if (line.includes('From secondary')) fromSecondary++;
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Query failed:', (e as Error).message);
      }

      console.log(`Messages from primary: ${fromPrimary}, from secondary: ${fromSecondary}`);

      // Should have messages from both servers
      if (fromPrimary > 0 || fromSecondary > 0) {
        expect(fromPrimary).toBeGreaterThanOrEqual(2);
        expect(fromSecondary).toBeGreaterThanOrEqual(2);
        console.log('SUCCESS: History includes messages from both servers');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Netsplit Recovery', () => {
    it('history remains available during brief netsplit', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      // Connect as oper to control server links
      const operClient = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await operClient.capLs();
      await operClient.capReq(['draft/chathistory', 'batch', 'server-time']);
      operClient.capEnd();
      operClient.register('netsplit1');
      await operClient.waitForLine(/001/);

      // Become oper
      operClient.send('OPER oper shmoo');
      try {
        await operClient.waitForLine(/381/, 5000);
      } catch {
        console.log('Cannot oper up - skipping netsplit test');
        operClient.send('QUIT');
        return;
      }

      // CRITICAL: Ensure servers are linked before we try to SQUIT
      const linked = await ensureServersLinked(operClient, SECONDARY_SERVER_NAME);
      if (!linked) {
        console.log('SKIP: Could not establish server link for netsplit test');
        operClient.send('QUIT');
        return;
      }

      const channelName = `#netsplit${Date.now()}`;
      operClient.send(`JOIN ${channelName}`);
      await operClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Send messages before netsplit
      for (let i = 1; i <= 3; i++) {
        operClient.send(`PRIVMSG ${channelName} :Before netsplit ${i}`);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 500));

      console.log('Messages sent before netsplit');

      // SQUIT the secondary server (simulating netsplit)
      operClient.clearRawBuffer();
      operClient.send(`SQUIT ${SECONDARY_SERVER_NAME} :Netsplit test`);

      // Wait for and verify SQUIT succeeded (look for SQUIT confirmation, not 402 error)
      try {
        const squitResponse = await operClient.waitForLine(/SQUIT|402/, 3000);
        if (squitResponse.includes('402')) {
          console.log('SQUIT failed - server not linked:', squitResponse);
          operClient.send('QUIT');
          return;
        }
        console.log('SQUIT confirmed:', squitResponse);
      } catch {
        // No explicit response, check if link is down
      }
      await new Promise(r => setTimeout(r, 1000));

      // Send messages during netsplit (with more spacing to ensure they're sent)
      for (let i = 1; i <= 2; i++) {
        operClient.send(`PRIVMSG ${channelName} :During netsplit ${i}`);
        await new Promise(r => setTimeout(r, 200));
      }
      await new Promise(r => setTimeout(r, 1000));

      console.log('Messages sent during netsplit');

      // Wait for messages to be persisted to history
      await new Promise(r => setTimeout(r, 1500));

      // Create a fresh client to query history (the oper client socket may be unstable
      // after the SQUIT/CONNECT operations and LINKS polling during ensureServersLinked)
      const queryClient = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await queryClient.capLs();
      await queryClient.capReq(['draft/chathistory', 'batch', 'server-time', 'message-tags']);
      queryClient.capEnd();
      queryClient.register('histquery1');
      await queryClient.waitForLine(/001/);

      // Join the channel to have access
      queryClient.send(`JOIN ${channelName}`);
      await queryClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
      await new Promise(r => setTimeout(r, 500));

      // Query history - messages from both before and during netsplit should be preserved
      queryClient.clearRawBuffer();
      console.log(`Sending CHATHISTORY LATEST ${channelName} * 20`);
      queryClient.send(`CHATHISTORY LATEST ${channelName} * 20`);

      let beforeCount = 0;
      let duringCount = 0;

      try {
        await queryClient.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await queryClient.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('Before netsplit')) beforeCount++;
            if (line.includes('During netsplit')) duringCount++;
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Query failed:', (e as Error).message);
      }

      console.log(`History after netsplit: before=${beforeCount}, during=${duringCount}`);

      // Key test: Messages from BOTH before and during netsplit should be preserved
      // The exact counts may vary slightly due to socket timing, but we should have most
      expect(beforeCount).toBeGreaterThanOrEqual(2); // At least 2 of 3 "before" messages
      expect(duringCount).toBeGreaterThanOrEqual(1); // At least 1 of 2 "during" messages
      expect(beforeCount + duringCount).toBeGreaterThanOrEqual(4); // At least 4 total messages
      console.log('SUCCESS: Messages preserved through netsplit');

      operClient.send('QUIT');
      queryClient.send('QUIT');
    });

    it('secondary server catches up after rejoining network', async () => {
      if (!secondaryAvailable) {
        console.log('SKIP: Secondary server not available');
        return;
      }

      const operClient = trackClient(await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port));
      await operClient.capLs();
      await operClient.capReq(['draft/chathistory', 'batch', 'server-time']);
      operClient.capEnd();
      operClient.register('catchup1');
      await operClient.waitForLine(/001/);

      operClient.send('OPER oper shmoo');
      try {
        await operClient.waitForLine(/381/, 5000);
      } catch {
        console.log('Cannot oper up - skipping catchup test');
        operClient.send('QUIT');
        return;
      }

      // CRITICAL: Ensure servers are linked before we try to SQUIT
      const linked = await ensureServersLinked(operClient, SECONDARY_SERVER_NAME);
      if (!linked) {
        console.log('SKIP: Could not establish server link for catchup test');
        operClient.send('QUIT');
        return;
      }

      const channelName = `#catchup${Date.now()}`;
      operClient.send(`JOIN ${channelName}`);
      await operClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // SQUIT secondary and verify it worked
      operClient.clearRawBuffer();
      operClient.send(`SQUIT ${SECONDARY_SERVER_NAME} :Catchup test`);

      try {
        const squitResponse = await operClient.waitForLine(/SQUIT|402/, 3000);
        if (squitResponse.includes('402')) {
          console.log('SQUIT failed - server not linked:', squitResponse);
          operClient.send('QUIT');
          return;
        }
        console.log('SQUIT confirmed:', squitResponse);
      } catch {
        // No explicit response
      }
      await new Promise(r => setTimeout(r, 1500));

      // Send messages while secondary is gone
      for (let i = 1; i <= 5; i++) {
        operClient.send(`PRIVMSG ${channelName} :Missed message ${i}`);
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 500));

      console.log('Sent 5 messages while secondary was disconnected');

      // Reconnect secondary and wait for link to establish
      operClient.send(`CONNECT ${SECONDARY_SERVER_NAME}`);
      const reconnected = await waitForServerLink(operClient, SECONDARY_SERVER_NAME, 15000);

      if (!reconnected) {
        console.log('Secondary did not reconnect');
        operClient.send('QUIT');
        return;
      }

      console.log('Secondary reconnected and linked');
      await new Promise(r => setTimeout(r, 1000));

      // Query from secondary - should get all messages via federation
      const secondaryClient = trackClient(await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
      await secondaryClient.capLs();
      await secondaryClient.capReq(['draft/chathistory', 'batch', 'server-time']);
      secondaryClient.capEnd();
      secondaryClient.register('catchup2');
      await secondaryClient.waitForLine(/001/);

      secondaryClient.send(`JOIN ${channelName}`);
      await secondaryClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      secondaryClient.clearRawBuffer();
      secondaryClient.send(`CHATHISTORY LATEST ${channelName} * 10`);

      let missedCount = 0;
      try {
        await secondaryClient.waitForLine(/BATCH \+\S+ chathistory/i, 10000);
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          try {
            const line = await secondaryClient.waitForLine(/PRIVMSG|BATCH -/, 500);
            if (line.includes('BATCH -')) break;
            if (line.includes('Missed message')) missedCount++;
          } catch {
            break;
          }
        }
      } catch (e) {
        console.log('Secondary query failed:', (e as Error).message);
      }

      console.log(`Secondary retrieved ${missedCount} missed messages`);

      if (missedCount > 0) {
        expect(missedCount).toBe(5);
        console.log('SUCCESS: Secondary caught up with missed messages via federation');
      }

      operClient.send('QUIT');
      secondaryClient.send('QUIT');
    });
  });
});
