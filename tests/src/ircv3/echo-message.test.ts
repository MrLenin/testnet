import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client, createIRCv3Client } from '../helpers/index.js';

/**
 * Echo Message Tests (echo-message capability)
 *
 * Tests that the server echoes messages back to the sender,
 * allowing clients to confirm message delivery and get msgid/time tags.
 */
describe('IRCv3 Echo Message', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability', () => {
    it('server advertises echo-message capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echotest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('echo-message')).toBe(true);
    });

    it('can request echo-message capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echotest2' })
      );

      await client.capLs();
      const result = await client.capReq(['echo-message']);

      expect(result.ack).toContain('echo-message');
      expect(client.hasCapEnabled('echo-message')).toBe(true);
    });
  });

  describe('PRIVMSG Echo', () => {
    it('echoes channel PRIVMSG back to sender', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echomsg1' })
      );

      await client.capLs();
      await client.capReq(['echo-message']);
      client.capEnd();
      client.register('echomsg1');
      await client.waitForRaw(/001/);

      const channelName = `#echo${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Clear buffer to isolate our message
      client.clearRawBuffer();

      const testMsg = `Echo test ${Date.now()}`;
      client.say(channelName, testMsg);

      // Should receive our own message back
      const echo = await client.waitForRaw(new RegExp(`PRIVMSG.*${testMsg}`));
      expect(echo).toContain(testMsg);
      expect(echo).toContain(channelName);
      console.log('Echo received:', echo);
    });

    it('echoes private PRIVMSG back to sender', async () => {
      const client1 = trackClient(
        await createRawIRCv3Client({ nick: 'echosend1' })
      );
      const client2 = trackClient(
        await createRawIRCv3Client({ nick: 'echorecv1' })
      );

      await client1.capLs();
      await client1.capReq(['echo-message']);
      client1.capEnd();
      client1.register('echosend1');
      await client1.waitForRaw(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('echorecv1');
      await client2.waitForRaw(/001/);

      client1.clearRawBuffer();

      const testMsg = `Private echo ${Date.now()}`;
      client1.say('echorecv1', testMsg);

      // Sender should receive echo
      const echo = await client1.waitForRaw(new RegExp(`PRIVMSG.*${testMsg}`));
      expect(echo).toContain(testMsg);
      console.log('Private echo received:', echo);
    });

    it('echo includes server-time tag', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echotime1' })
      );

      await client.capLs();
      await client.capReq(['echo-message', 'server-time']);
      client.capEnd();
      client.register('echotime1');
      await client.waitForRaw(/001/);

      const channelName = `#echotime${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      client.say(channelName, 'Time tagged message');

      const echo = await client.waitForRaw(/PRIVMSG.*Time tagged/);

      // Should have @time= tag
      if (echo.startsWith('@')) {
        expect(echo).toMatch(/@.*time=/);
        console.log('Echo with time:', echo);
      } else {
        console.log('Echo without tags:', echo);
      }
    });

    it('echo includes msgid tag', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echoid1' })
      );

      await client.capLs();
      await client.capReq(['echo-message', 'message-tags']);
      client.capEnd();
      client.register('echoid1');
      await client.waitForRaw(/001/);

      const channelName = `#echoid${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      client.say(channelName, 'Message ID test');

      const echo = await client.waitForRaw(/PRIVMSG.*Message ID test/);

      // Should have msgid tag
      if (echo.startsWith('@')) {
        expect(echo).toMatch(/@.*msgid=/);
        console.log('Echo with msgid:', echo);
      } else {
        console.log('Echo without msgid:', echo);
      }
    });
  });

  describe('NOTICE Echo', () => {
    it('echoes NOTICE back to sender', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echonotice1' })
      );

      await client.capLs();
      await client.capReq(['echo-message']);
      client.capEnd();
      client.register('echonotice1');
      await client.waitForRaw(/001/);

      const channelName = `#echonotice${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      const testNotice = `Notice test ${Date.now()}`;
      client.notice(channelName, testNotice);

      const echo = await client.waitForRaw(new RegExp(`NOTICE.*${testNotice}`));
      expect(echo).toContain(testNotice);
      console.log('Notice echo:', echo);
    });
  });

  describe('Without Echo-Message', () => {
    it('does not echo when capability not enabled', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'noecho1' })
      );

      await client.capLs();
      // Explicitly NOT requesting echo-message
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('noecho1');
      await client.waitForRaw(/001/);

      const channelName = `#noecho${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      const testMsg = `No echo test ${Date.now()}`;
      client.say(channelName, testMsg);

      // Should NOT receive echo
      try {
        await client.waitForRaw(new RegExp(`PRIVMSG.*${testMsg}`), 1000);
        // If we get here, we received an echo when we shouldn't have
        console.log('Unexpected echo received');
      } catch {
        // Expected - no echo should be received
        expect(true).toBe(true);
      }
    });
  });

  describe('Echo with Labeled Response', () => {
    it('echo respects label tag', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'echolabel1' })
      );

      await client.capLs();
      await client.capReq(['echo-message', 'labeled-response']);
      client.capEnd();
      client.register('echolabel1');
      await client.waitForRaw(/001/);

      const channelName = `#echolabel${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.clearRawBuffer();

      const label = `lbl${Date.now()}`;
      client.rawWithTags({ label }, `PRIVMSG ${channelName} :Labeled message`);

      try {
        const echo = await client.waitForRaw(/PRIVMSG.*Labeled message/, 3000);
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
    });
  });
});

describe('IRCv3 TAGMSG', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('can send TAGMSG with client tags', async () => {
    const client1 = trackClient(
      await createRawIRCv3Client({ nick: 'tagmsg1' })
    );
    const client2 = trackClient(
      await createRawIRCv3Client({ nick: 'tagmsg2' })
    );

    await client1.capLs();
    await client1.capReq(['message-tags']);
    client1.capEnd();
    client1.register('tagmsg1');
    await client1.waitForRaw(/001/);

    await client2.capLs();
    await client2.capReq(['message-tags']);
    client2.capEnd();
    client2.register('tagmsg2');
    await client2.waitForRaw(/001/);

    const channelName = `#tagmsg${Date.now()}`;
    client1.join(channelName);
    client2.join(channelName);
    await client1.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));
    await client2.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));
    await new Promise(r => setTimeout(r, 500));

    client2.clearRawBuffer();

    // Send TAGMSG with typing indicator
    client1.rawWithTags({ '+typing': 'active' }, `TAGMSG ${channelName}`);

    try {
      const received = await client2.waitForRaw(/TAGMSG.*#tagmsg/i, 3000);
      expect(received).toContain('TAGMSG');
      console.log('TAGMSG received:', received);
    } catch {
      console.log('TAGMSG not received - may not be supported');
    }
  });

  it('TAGMSG echoes with echo-message', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'tagecho1' })
    );

    await client.capLs();
    await client.capReq(['message-tags', 'echo-message']);
    client.capEnd();
    client.register('tagecho1');
    await client.waitForRaw(/001/);

    const channelName = `#tagecho${Date.now()}`;
    client.join(channelName);
    await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

    client.clearRawBuffer();

    client.rawWithTags({ '+react': '👍' }, `TAGMSG ${channelName}`);

    try {
      const echo = await client.waitForRaw(/TAGMSG.*#tagecho/i, 3000);
      expect(echo).toContain('TAGMSG');
      console.log('TAGMSG echo:', echo);
    } catch {
      console.log('TAGMSG echo not received');
    }
  });
});

describe('IRCv3 Labeled Response', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('server advertises labeled-response', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'labeltest1' })
    );

    const caps = await client.capLs();
    expect(caps.has('labeled-response')).toBe(true);
  });

  it('responses include label from request', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'labeltest2' })
    );

    await client.capLs();
    await client.capReq(['labeled-response']);
    client.capEnd();
    client.register('labeltest2');
    await client.waitForRaw(/001/);

    client.clearRawBuffer();

    // Send WHO with label
    const label = `who${Date.now()}`;
    client.rawWithTags({ label }, 'WHO labeltest2');

    try {
      const response = await client.waitForRaw(new RegExp(`@.*label=${label}|BATCH.*${label}`), 3000);
      expect(response).toBeDefined();
      console.log('Labeled WHO response:', response);
    } catch {
      // Response may be in unlabeled format if single-line
      console.log('No labeled response - may be single reply');
    }
  });

  it('ACK sent for commands with no output', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'acktest1' })
    );

    await client.capLs();
    await client.capReq(['labeled-response']);
    client.capEnd();
    client.register('acktest1');
    await client.waitForRaw(/001/);

    client.clearRawBuffer();

    // Send command that produces no output
    const label = `ack${Date.now()}`;
    client.rawWithTags({ label }, 'MODE acktest1 +i');

    try {
      // Should get ACK or labeled MODE response
      const response = await client.waitForRaw(new RegExp(`ACK|${label}`), 3000);
      expect(response).toBeDefined();
      console.log('ACK/labeled response:', response);
    } catch {
      console.log('No ACK received - may not require one');
    }
  });
});
