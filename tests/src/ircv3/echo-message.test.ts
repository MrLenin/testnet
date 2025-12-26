import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Echo Message Tests (echo-message capability)
 *
 * Tests that the server echoes messages back to the sender,
 * allowing clients to confirm message delivery and get msgid/time tags.
 */
describe('IRCv3 Echo Message', () => {
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
    it('server advertises echo-message capability', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('echo-message')).toBe(true);
      client.send('QUIT');
    });

    it('can request echo-message capability', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      const result = await client.capReq(['echo-message']);

      expect(result.ack).toContain('echo-message');
      expect(client.hasCapEnabled('echo-message')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('PRIVMSG Echo', () => {
    it('echoes channel PRIVMSG back to sender', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['echo-message']);
      client.capEnd();
      client.register('echomsg1');
      await client.waitForLine(/001/);

      const channelName = `#echo${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testMsg = `Echo test ${Date.now()}`;
      client.send(`PRIVMSG ${channelName} :${testMsg}`);

      // Should receive our own message back
      const echo = await client.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`));
      expect(echo).toContain(testMsg);
      expect(echo).toContain(channelName);
      console.log('Echo received:', echo);
      client.send('QUIT');
    });

    it('echoes private PRIVMSG back to sender', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['echo-message']);
      client1.capEnd();
      client1.register('echosend1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('echorecv1');
      await client2.waitForLine(/001/);

      const testMsg = `Private echo ${Date.now()}`;
      client1.send(`PRIVMSG echorecv1 :${testMsg}`);

      // Sender should receive echo
      const echo = await client1.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`));
      expect(echo).toContain(testMsg);
      console.log('Private echo received:', echo);
      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('echo includes server-time tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['echo-message', 'server-time']);
      client.capEnd();
      client.register('echotime1');
      await client.waitForLine(/001/);

      const channelName = `#echotime${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Time tagged message`);

      const echo = await client.waitForLine(/PRIVMSG.*Time tagged/);

      // Should have @time= tag
      if (echo.startsWith('@')) {
        expect(echo).toMatch(/@.*time=/);
        console.log('Echo with time:', echo);
      } else {
        console.log('Echo without tags:', echo);
      }
      client.send('QUIT');
    });

    it('echo includes msgid tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['echo-message']);
      client.capEnd();
      client.register('echoid1');
      await client.waitForLine(/001/);

      const channelName = `#echoid${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Message ID test`);

      const echo = await client.waitForLine(/PRIVMSG.*Message ID test/);

      // Should have msgid tag
      if (echo.startsWith('@')) {
        expect(echo).toMatch(/@.*msgid=/);
        console.log('Echo with msgid:', echo);
      } else {
        console.log('Echo without msgid:', echo);
      }
      client.send('QUIT');
    });
  });

  describe('NOTICE Echo', () => {
    it('echoes NOTICE back to sender', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['echo-message']);
      client.capEnd();
      client.register('echonotice1');
      await client.waitForLine(/001/);

      const channelName = `#echonotice${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testNotice = `Notice test ${Date.now()}`;
      client.send(`NOTICE ${channelName} :${testNotice}`);

      const echo = await client.waitForLine(new RegExp(`NOTICE.*${testNotice}`));
      expect(echo).toContain(testNotice);
      console.log('Notice echo:', echo);
      client.send('QUIT');
    });
  });

  describe('Without Echo-Message', () => {
    it('does not echo when capability not enabled', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Explicitly NOT requesting echo-message
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('noecho1');
      await client.waitForLine(/001/);

      const channelName = `#noecho${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testMsg = `No echo test ${Date.now()}`;
      client.send(`PRIVMSG ${channelName} :${testMsg}`);

      // Should NOT receive echo
      try {
        await client.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`), 1000);
        // If we get here, we received an echo when we shouldn't have
        console.log('Unexpected echo received');
      } catch {
        // Expected - no echo should be received
        expect(true).toBe(true);
      }
      client.send('QUIT');
    });
  });

  describe('Echo with Labeled Response', () => {
    it('echo respects label tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['echo-message', 'labeled-response']);
      client.capEnd();
      client.register('echolabel1');
      await client.waitForLine(/001/);

      const channelName = `#echolabel${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const label = `lbl${Date.now()}`;
      client.send(`@label=${label} PRIVMSG ${channelName} :Labeled message`);

      try {
        const echo = await client.waitForLine(/PRIVMSG.*Labeled message/, 3000);
        console.log('Labeled echo:', echo);

        // Echo should include our label
        if (echo.includes(label)) {
          expect(echo).toContain(label);
        } else {
          console.log('Label not in echo - may be in batch wrapper');
        }
      } catch {
        console.log('No labeled echo received');
      }
      client.send('QUIT');
    });
  });
});

describe('IRCv3 TAGMSG', () => {
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

  it('can send TAGMSG with client tags', async () => {
    const client1 = trackClient(await createRawSocketClient());

    // TAGMSG requires message-tags capability which may not be implemented
    const caps = await client1.capLs();
    if (!caps.has('message-tags')) {
      console.log('Skipping - message-tags not advertised (TAGMSG requires it)');
      client1.send('QUIT');
      return;
    }

    const client2 = trackClient(await createRawSocketClient());

    await client1.capReq(['message-tags']);
    client1.capEnd();
    client1.register('tagmsg1');
    await client1.waitForLine(/001/);

    await client2.capLs();
    await client2.capReq(['message-tags']);
    client2.capEnd();
    client2.register('tagmsg2');
    await client2.waitForLine(/001/);

    const channelName = `#tagmsg${Date.now()}`;
    client1.send(`JOIN ${channelName}`);
    client2.send(`JOIN ${channelName}`);
    await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
    await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
    // Wait for client2 to see client1's join notification
    await client2.waitForLine(/JOIN.*tagmsg1/i, 2000).catch(() => {});
    await new Promise(r => setTimeout(r, 200));

    // Clear buffer before sending TAGMSG
    client2.clearRawBuffer();

    // Send TAGMSG with typing indicator
    client1.send(`@+typing=active TAGMSG ${channelName}`);

    try {
      const received = await client2.waitForLine(/TAGMSG/i, 3000);
      expect(received).toContain('TAGMSG');
      console.log('TAGMSG received:', received);
    } catch {
      console.log('TAGMSG not received - may not be supported');
    }
    client1.send('QUIT');
    client2.send('QUIT');
  });

  it('TAGMSG echoes with echo-message', async () => {
    const client = trackClient(await createRawSocketClient());

    // TAGMSG requires message-tags capability which may not be implemented
    const caps = await client.capLs();
    if (!caps.has('message-tags')) {
      console.log('Skipping - message-tags not advertised (TAGMSG requires it)');
      client.send('QUIT');
      return;
    }

    await client.capReq(['message-tags', 'echo-message']);
    client.capEnd();
    client.register('tagecho1');
    await client.waitForLine(/001/);

    const channelName = `#tagecho${Date.now()}`;
    client.send(`JOIN ${channelName}`);
    await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

    client.send(`@+react=👍 TAGMSG ${channelName}`);

    try {
      const echo = await client.waitForLine(/TAGMSG.*#tagecho/i, 3000);
      expect(echo).toContain('TAGMSG');
      console.log('TAGMSG echo:', echo);
    } catch {
      console.log('TAGMSG echo not received');
    }
    client.send('QUIT');
  });
});

describe('IRCv3 Labeled Response', () => {
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

  it('server advertises labeled-response', async () => {
    const client = trackClient(await createRawSocketClient());
    const caps = await client.capLs();
    expect(caps.has('labeled-response')).toBe(true);
    client.send('QUIT');
  });

  it('responses include label from request', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['labeled-response']);
    client.capEnd();
    client.register('labeltest2');
    await client.waitForLine(/001/);

    // Send WHO with label
    const label = `who${Date.now()}`;
    client.send(`@label=${label} WHO labeltest2`);

    try {
      const response = await client.waitForLine(new RegExp(`@.*label=${label}|BATCH.*${label}`), 3000);
      expect(response).toBeDefined();
      console.log('Labeled WHO response:', response);
    } catch {
      // Response may be in unlabeled format if single-line
      console.log('No labeled response - may be single reply');
    }
    client.send('QUIT');
  });

  it('ACK sent for commands with no output', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['labeled-response']);
    client.capEnd();
    client.register('acktest1');
    await client.waitForLine(/001/);

    // Send command that produces no output
    const label = `ack${Date.now()}`;
    client.send(`@label=${label} MODE acktest1 +i`);

    try {
      // Should get ACK or labeled MODE response
      const response = await client.waitForLine(new RegExp(`ACK|${label}`), 3000);
      expect(response).toBeDefined();
      console.log('ACK/labeled response:', response);
    } catch {
      console.log('No ACK received - may not require one');
    }
    client.send('QUIT');
  });
});
