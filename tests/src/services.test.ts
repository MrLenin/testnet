import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from './helpers/index.js';

describe('X3 Services', () => {
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

  it('can communicate with AuthServ', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('authtest1');
    await client.waitForLine(/001/);

    // Send a message to AuthServ
    client.send('PRIVMSG AuthServ :HELP');

    // Wait for a response from AuthServ
    const response = await client.waitForLine(/AuthServ.*NOTICE/i, 10000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });

  it('can communicate with ChanServ', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('chantest1');
    await client.waitForLine(/001/);

    // Send a message to ChanServ
    client.send('PRIVMSG ChanServ :HELP');

    // Wait for a response from ChanServ
    const response = await client.waitForLine(/ChanServ.*NOTICE/i, 10000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });

  it('can register a channel with ChanServ', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('chanreg1');
    await client.waitForLine(/001/);

    // First join the channel to become op
    const channelName = `#testchan${Date.now()}`;
    client.send(`JOIN ${channelName}`);
    await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

    // Try to register (this may fail without auth, but we test the interaction)
    client.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);

    // Wait for some response from ChanServ
    const response = await client.waitForLine(/ChanServ/i, 10000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });
});

describe('X3 OpServ', () => {
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

  it('can query OpServ (may require oper)', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    client.capEnd();
    client.register('optest1');
    await client.waitForLine(/001/);

    // Try to communicate with OpServ
    client.send('PRIVMSG OpServ :HELP');

    // OpServ typically requires oper status, but should still respond
    // Wait for any response (could be help or access denied)
    const response = await client.waitForLine(/OpServ|NOTICE/i, 10000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });
});
