import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueId } from './helpers/index.js';

describe('IRC Connection', () => {
  const clients: RawSocketClient[] = [];

  // Helper to track clients for cleanup
  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    // Clean up all clients after each test
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('can connect to the IRC server', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('testuser1');
    await client.waitForLine(/001/);

    // If we get here, connection succeeded
    expect(client).toBeDefined();
    client.send('QUIT');
  });

  it('receives welcome message on connect', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('testuser2');

    // Wait for 001 (RPL_WELCOME)
    const welcome = await client.waitForLine(/001/);
    expect(welcome).toContain('001');
    client.send('QUIT');
  });

  it('can join a channel', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('testuser3');
    await client.waitForLine(/001/);

    client.send('JOIN #test');

    // Wait for JOIN confirmation
    const joinMsg = await client.waitForLine(/JOIN.*#test/i);
    expect(joinMsg).toContain('#test');
    client.send('QUIT');
  });

  it('can send and receive messages in a channel', async () => {
    // Create two clients
    const client1 = trackClient(await createRawSocketClient());
    const client2 = trackClient(await createRawSocketClient());

    await client1.capLs();
    client1.capEnd();
    client1.register('sender1');
    await client1.waitForLine(/001/);

    await client2.capLs();
    client2.capEnd();
    client2.register('receiver1');
    await client2.waitForLine(/001/);

    // Both join the same channel
    client1.send('JOIN #msgtest');
    client2.send('JOIN #msgtest');

    // Wait for both to join
    await client1.waitForLine(/JOIN.*#msgtest/i);
    await client2.waitForLine(/JOIN.*#msgtest/i);

    // Small delay to ensure channel state is synced
    await new Promise((r) => setTimeout(r, 500));

    // Client 1 sends a message
    const testMessage = `Hello from test ${uniqueId()}`;
    client1.send(`PRIVMSG #msgtest :${testMessage}`);

    // Client 2 should receive it
    const received = await client2.waitForLine(new RegExp(testMessage));
    expect(received).toContain(testMessage);
    client1.send('QUIT');
    client2.send('QUIT');
  });

  it('can change nickname', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('oldnick1');
    await client.waitForLine(/001/);

    client.send('NICK newnick1');

    // Wait for NICK confirmation
    const nickMsg = await client.waitForLine(/NICK.*newnick1/i);
    expect(nickMsg).toContain('newnick1');
    client.send('QUIT');
  });
});
