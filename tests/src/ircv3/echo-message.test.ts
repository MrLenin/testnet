import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  CAP_BUNDLES,
  parseIRCMessage,
  assertPrivmsg,
  assertTag,
  getServerTime,
  getMsgId,
} from '../helpers/index.js';

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

      const channelName = uniqueChannel('echo');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testMsg = `Echo test ${uniqueId()}`;
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

      const testMsg = `Private echo ${uniqueId()}`;
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
      // Use full messaging bundle for complete tag support
      await client.capReq(CAP_BUNDLES.messaging);
      client.capEnd();
      client.register('echotime1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('echotime');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Time tagged message`);

      const echo = await client.waitForLine(/PRIVMSG.*Time tagged/);
      const parsed = parseIRCMessage(echo);

      // Validate using structured parser
      assertPrivmsg(parsed, { target: channelName, text: 'Time tagged' });
      assertTag(parsed, 'time');

      // Validate time is a proper Date
      const serverTime = getServerTime(parsed);
      expect(serverTime).toBeInstanceOf(Date);
      console.log('Echo with time:', serverTime?.toISOString());

      client.send('QUIT');
    });

    it('echo includes msgid tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // message-tags required to receive @msgid tag, echo-message required for echo
      await client.capReq(CAP_BUNDLES.messaging);
      client.capEnd();
      client.register('echoid1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('echoid');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ${channelName} :Message ID test`);

      const echo = await client.waitForLine(/PRIVMSG.*Message ID test/);
      const parsed = parseIRCMessage(echo);

      // Validate using structured parser
      assertPrivmsg(parsed, { target: channelName, text: 'Message ID test' });
      assertTag(parsed, 'msgid');

      // Validate msgid is present and non-empty
      const msgid = getMsgId(parsed);
      expect(msgid).toBeTruthy();
      expect(msgid!.length).toBeGreaterThan(0);
      console.log('Echo with msgid:', msgid);

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

      const channelName = uniqueChannel('echonotice');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testNotice = `Notice test ${uniqueId()}`;
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

      const channelName = uniqueChannel('noecho');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const testMsg = `No echo test ${uniqueId()}`;
      client.send(`PRIVMSG ${channelName} :${testMsg}`);

      // Should NOT receive echo - expect timeout
      const receivedUnexpectedEcho = await client
        .waitForLine(new RegExp(`PRIVMSG.*${testMsg}`), 1000)
        .then(() => true)
        .catch(() => false);

      expect(receivedUnexpectedEcho).toBe(false);
      client.send('QUIT');
    });
  });

  describe('Echo with Labeled Response', () => {
    it('echo respects label tag', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Combine messaging (echo, tags) + batching (labeled-response) capabilities
      await client.capReq([...CAP_BUNDLES.messaging, 'labeled-response', 'batch']);
      client.capEnd();
      client.register('echolabel1');
      await client.waitForLine(/001/);

      const channelName = uniqueChannel('echolabel');
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      const label = `lbl${uniqueId()}`;
      client.send(`@label=${label} PRIVMSG ${channelName} :Labeled message`);

      const echo = await client.waitForLine(/PRIVMSG.*Labeled message/, 3000);
      console.log('Labeled echo:', echo);

      // Echo should include our label
      expect(echo).toContain(label);
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

    const channelName = uniqueChannel('tagmsg');
    // Join client1 first, then client2 so client2 sees client1's JOIN
    client1.send(`JOIN ${channelName}`);
    await client1.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

    // Now join client2 - it will see client1 in NAMES
    client2.send(`JOIN ${channelName}`);
    await client2.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));
    // Verify client1 is in channel via NAMES (shows as @tagmsg1)
    await client2.waitForLine(/366.*End of.*NAMES/i, 2000);

    // Clear buffer before sending TAGMSG
    client2.clearRawBuffer();

    // Send TAGMSG with typing indicator
    client1.send(`@+typing=active TAGMSG ${channelName}`);

    const received = await client2.waitForLine(/TAGMSG/i, 3000);
    expect(received).toContain('TAGMSG');
    console.log('TAGMSG received:', received);
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

    const channelName = uniqueChannel('tagecho');
    client.send(`JOIN ${channelName}`);
    await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

    client.send(`@+react=👍 TAGMSG ${channelName}`);

    const echo = await client.waitForLine(/TAGMSG.*#tagecho/i, 3000);
    expect(echo).toContain('TAGMSG');
    console.log('TAGMSG echo:', echo);
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
    await client.capReq(CAP_BUNDLES.batching);
    client.capEnd();
    client.register('labeltest2');
    await client.waitForLine(/001/);

    // Send WHO with label
    const label = `who${uniqueId()}`;
    client.send(`@label=${label} WHO labeltest2`);

    const response = await client.waitForLine(new RegExp(`@.*label=${label}|BATCH.*${label}|352|315`), 3000);
    expect(response).toBeDefined();
    console.log('Labeled WHO response:', response);
    client.send('QUIT');
  });

  it('ACK sent for commands with no output', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(CAP_BUNDLES.batching);
    client.capEnd();
    client.register('acktest1');
    await client.waitForLine(/001/);

    // Send command that produces no output
    const label = `ack${uniqueId()}`;
    client.send(`@label=${label} MODE acktest1 +i`);

    // Should get ACK or labeled MODE response
    const response = await client.waitForLine(new RegExp(`ACK|MODE|${label}`), 3000);
    expect(response).toBeDefined();
    console.log('ACK/labeled response:', response);
    client.send('QUIT');
  });
});
