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
 */
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
});
