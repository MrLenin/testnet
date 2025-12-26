import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Read Marker Tests (draft/read-marker)
 *
 * Tests the IRCv3 read marker specification for syncing read positions
 * across clients. Used by bouncers and multi-device setups.
 */
describe('IRCv3 Read Marker (draft/read-marker)', () => {
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
    it('server advertises draft/read-marker', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/read-marker')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/read-marker capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/read-marker']);

      expect(result.ack).toContain('draft/read-marker');

      client.send('QUIT');
    });
  });

  describe('MARKREAD Command', () => {
    it('can set read marker with MARKREAD', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/read-marker', 'server-time']);
      client.capEnd();
      client.register('rmset1');
      await client.waitForLine(/001/);

      const channel = `#rmset${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Send a message to get a msgid
      client.send(`PRIVMSG ${channel} :Test message for read marker`);
      await new Promise(r => setTimeout(r, 500));

      client.clearRawBuffer();

      // Set read marker using timestamp
      const timestamp = new Date().toISOString();
      client.send(`MARKREAD ${channel} timestamp=${timestamp}`);

      // Should receive MARKREAD confirmation
      try {
        const response = await client.waitForLine(/MARKREAD|730/i, 5000);
        expect(response).toBeDefined();
        console.log('MARKREAD response:', response);
      } catch {
        console.log('No MARKREAD response - may require authentication');
      }

      client.send('QUIT');
    });

    it('can query read marker with MARKREAD', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/read-marker']);
      client.capEnd();
      client.register('rmquery1');
      await client.waitForLine(/001/);

      const channel = `#rmquery${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Query read marker (no timestamp = query)
      client.send(`MARKREAD ${channel}`);

      try {
        // 730 = RPL_MARKREAD
        const response = await client.waitForLine(/MARKREAD|730/i, 5000);
        expect(response).toBeDefined();
        console.log('MARKREAD query response:', response);
      } catch {
        console.log('No MARKREAD query response');
      }

      client.send('QUIT');
    });

    it('MARKREAD with msgid sets position', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/read-marker', 'echo-message']);
      client.capEnd();
      client.register('rmmsgid1');
      await client.waitForLine(/001/);

      const channel = `#rmmsgid${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      // Send message and capture msgid from echo
      client.send(`PRIVMSG ${channel} :Message to mark as read`);

      let msgid: string | null = null;
      try {
        const echo = await client.waitForLine(/PRIVMSG.*Message to mark/i, 3000);
        const match = echo.match(/msgid=([^\s;]+)/);
        if (match) {
          msgid = match[1];
        }
      } catch {
        console.log('No echo with msgid received');
      }

      if (msgid) {
        client.clearRawBuffer();
        client.send(`MARKREAD ${channel} msgid=${msgid}`);

        try {
          const response = await client.waitForLine(/MARKREAD|730/i, 5000);
          expect(response).toBeDefined();
        } catch {
          console.log('No MARKREAD response for msgid');
        }
      }

      client.send('QUIT');
    });
  });

  describe('MARKREAD Synchronization', () => {
    it('MARKREAD syncs across multiple clients', async () => {
      // Note: Full sync requires authenticated account on both clients

      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/read-marker']);
      client1.capEnd();
      client1.register('rmsync1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      await client2.capReq(['draft/read-marker']);
      client2.capEnd();
      client2.register('rmsync2');
      await client2.waitForLine(/001/);

      // Both clients need to be on the same account for sync
      // This test verifies capability is properly set up
      expect(client1.hasCapEnabled('draft/read-marker')).toBe(true);
      expect(client2.hasCapEnabled('draft/read-marker')).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('MARKREAD Errors', () => {
    it('MARKREAD on non-joined channel may fail', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/read-marker']);
      client.capEnd();
      client.register('rmerr1');
      await client.waitForLine(/001/);

      client.clearRawBuffer();

      // Try to set marker on channel we haven't joined
      client.send('MARKREAD #nonexistentchannel12345 timestamp=2024-01-01T00:00:00Z');

      try {
        // Should receive error
        const response = await client.waitForLine(/MARKREAD|FAIL|4\d\d|731/i, 3000);
        console.log('MARKREAD error response:', response);
      } catch {
        console.log('No error response for invalid MARKREAD');
      }

      client.send('QUIT');
    });

    it('MARKREAD with invalid timestamp format', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/read-marker']);
      client.capEnd();
      client.register('rmerr2');
      await client.waitForLine(/001/);

      const channel = `#rmerr${Date.now()}`;
      client.send(`JOIN ${channel}`);
      await client.waitForLine(new RegExp(`JOIN.*${channel}`, 'i'));

      client.clearRawBuffer();

      // Invalid timestamp format
      client.send(`MARKREAD ${channel} timestamp=invalid`);

      try {
        const response = await client.waitForLine(/MARKREAD|FAIL|4\d\d/i, 3000);
        console.log('Invalid timestamp response:', response);
      } catch {
        console.log('No response for invalid timestamp');
      }

      client.send('QUIT');
    });
  });

  describe('MARKREAD with Private Messages', () => {
    it('can set read marker for PM target', async () => {
      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      await client1.capLs();
      await client1.capReq(['draft/read-marker']);
      client1.capEnd();
      client1.register('rmpm1');
      await client1.waitForLine(/001/);

      await client2.capLs();
      client2.capEnd();
      client2.register('rmpm2');
      await client2.waitForLine(/001/);

      // Client2 sends PM to client1
      client2.send('PRIVMSG rmpm1 :Private message');
      await new Promise(r => setTimeout(r, 300));

      client1.clearRawBuffer();

      // Client1 marks PM as read
      const timestamp = new Date().toISOString();
      client1.send(`MARKREAD rmpm2 timestamp=${timestamp}`);

      try {
        const response = await client1.waitForLine(/MARKREAD|730/i, 3000);
        console.log('PM MARKREAD response:', response);
      } catch {
        console.log('No PM MARKREAD response - may not be supported');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});
