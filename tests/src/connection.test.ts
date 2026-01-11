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

    // Use parsed numeric matching instead of regex
    const welcome = await client.waitForNumeric('001');
    expect(welcome.command).toBe('001');

    client.send('QUIT');
  });

  it('receives welcome message on connect', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('testuser2');

    // Wait for 001 (RPL_WELCOME) using parsed matching
    const welcome = await client.waitForNumeric('001');
    expect(welcome.command).toBe('001');
    expect(welcome.params.length).toBeGreaterThan(0);

    client.send('QUIT');
  });

  it('can join a channel', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('testuser3');
    await client.waitForNumeric('001');

    client.send('JOIN #test');

    // Wait for JOIN confirmation using parsed matching
    const joinMsg = await client.waitForJoin('#test');
    expect(joinMsg.command).toBe('JOIN');
    expect(joinMsg.params[0].toLowerCase()).toBe('#test');

    client.send('QUIT');
  });

  it('can send and receive messages in a channel', async () => {
    // Create two clients
    const client1 = trackClient(await createRawSocketClient());
    const client2 = trackClient(await createRawSocketClient());

    await client1.capLs();
    client1.capEnd();
    client1.register('sender1');
    await client1.waitForNumeric('001');

    await client2.capLs();
    client2.capEnd();
    client2.register('receiver1');
    await client2.waitForNumeric('001');

    // Both join the same channel
    client1.send('JOIN #msgtest');
    client2.send('JOIN #msgtest');

    // Wait for both to join using parsed matching
    await client1.waitForJoin('#msgtest');
    await client2.waitForJoin('#msgtest');

    // Small delay to ensure channel state is synced
    await new Promise((r) => setTimeout(r, 500));

    // Client 1 sends a message
    const testMessage = `Hello from test ${uniqueId()}`;
    client1.send(`PRIVMSG #msgtest :${testMessage}`);

    // Client 2 should receive it - use parsed matching with content filter
    const received = await client2.waitForMessage('#msgtest', {
      command: 'PRIVMSG',
      containing: testMessage,
    });
    expect(received.params[1]).toContain(testMessage);

    client1.send('QUIT');
    client2.send('QUIT');
  });

  it('can change nickname', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('oldnick1');
    await client.waitForNumeric('001');

    client.send('NICK newnick1');

    // Wait for NICK confirmation using parsed matching
    const nickMsg = await client.waitForParsedLine(
      msg => msg.command === 'NICK' &&
             msg.params[0]?.toLowerCase() === 'newnick1',
      5000
    );
    expect(nickMsg.command).toBe('NICK');
    expect(nickMsg.params[0].toLowerCase()).toBe('newnick1');

    client.send('QUIT');
  });
});
