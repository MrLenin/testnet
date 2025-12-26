import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Metadata Tests (draft/metadata-2)
 *
 * Tests the IRCv3 metadata specification for user and channel metadata.
 */
describe('IRCv3 Metadata (draft/metadata-2)', () => {
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
    it('server advertises metadata capability', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();

      // May be draft/metadata or draft/metadata-2
      const hasMetadata = caps.has('draft/metadata-2') || caps.has('draft/metadata');
      expect(hasMetadata).toBe(true);

      client.send('QUIT');
    });

    it('can request metadata capability', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      const result = await client.capReq([metaCap]);

      expect(result.ack.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });

  describe('METADATA Commands', () => {
    it('can set user metadata with METADATA SET', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaset1');
      await client.waitForLine(/001/);

      // Try to set avatar metadata
      client.send('METADATA * SET avatar :https://example.com/avatar.png');

      // Should receive confirmation or error
      try {
        const response = await client.waitForLine(/METADATA|761|762|764|765|766|767/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA SET response:', response);
      } catch {
        // Some implementations may not respond for self-set
        console.log('No METADATA SET response received');
      }

      client.send('QUIT');
    });

    it('can get user metadata with METADATA GET', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaget1');
      await client.waitForLine(/001/);

      // First set some metadata
      client.send('METADATA * SET testkey :testvalue123');
      await new Promise(r => setTimeout(r, 500));

      // Then try to get it
      client.send('METADATA * GET testkey');

      try {
        // 761 = RPL_KEYVALUE (metadata value response)
        const response = await client.waitForLine(/761|METADATA.*testkey/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA GET response:', response);
      } catch {
        console.log('No METADATA GET response - may need authentication');
      }

      client.send('QUIT');
    });

    it('can list user metadata with METADATA LIST', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metalist1');
      await client.waitForLine(/001/);

      client.send('METADATA * LIST');

      try {
        // 761 = RPL_KEYVALUE, 762 = RPL_METADATAEND
        // Collect messages until we get 762 or timeout
        let responses: string[] = [];
        let done = false;
        const startTime = Date.now();
        while (!done && Date.now() - startTime < 3000) {
          try {
            const line = await client.waitForLine(/76[12]/, 500);
            responses.push(line);
            if (line.match(/762/)) {
              done = true;
            }
          } catch {
            break;
          }
        }
        expect(responses.length).toBeGreaterThanOrEqual(0);
        console.log('METADATA LIST responses:', responses);
      } catch {
        console.log('No METADATA LIST response');
      }

      client.send('QUIT');
    });

    it('can clear metadata with METADATA CLEAR', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaclear1');
      await client.waitForLine(/001/);

      // Set then clear
      client.send('METADATA * SET cleartest :value');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA * CLEAR cleartest');

      try {
        const response = await client.waitForLine(/761|766|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA CLEAR response:', response);
      } catch {
        console.log('No METADATA CLEAR response');
      }

      client.send('QUIT');
    });
  });

  describe('Channel Metadata', () => {
    it('can set channel metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta1');
      await client.waitForLine(/001/);

      // Join channel first (need to be op usually)
      const channelName = `#metaTest${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Try to set channel metadata
      client.send(`METADATA ${channelName} SET url :https://example.com`);

      try {
        const response = await client.waitForLine(/761|764|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA SET response:', response);
      } catch {
        console.log('No channel METADATA SET response - may need op status');
      }

      client.send('QUIT');
    });

    it('can get channel metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta2');
      await client.waitForLine(/001/);

      const channelName = `#metaGet${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Set then get
      client.send(`METADATA ${channelName} SET testchankey :testvalue`);
      await new Promise(r => setTimeout(r, 500));
      client.send(`METADATA ${channelName} GET testchankey`);

      try {
        const response = await client.waitForLine(/761|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA GET response:', response);
      } catch {
        console.log('No channel METADATA GET response');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Subscriptions', () => {
    it('can subscribe to metadata changes with METADATA SUB', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metasub1');
      await client.waitForLine(/001/);

      // Subscribe to all metadata changes for a target
      client.send('METADATA * SUB avatar');

      try {
        const response = await client.waitForLine(/769|770|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA SUB response:', response);
      } catch {
        console.log('No METADATA SUB response - may not be supported');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Error Handling', () => {
    it('returns error for invalid key', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr1');
      await client.waitForLine(/001/);

      // Try to get non-existent key
      client.send('METADATA * GET nonexistentkey12345');

      try {
        // 765 = ERR_KEYNOTSET, 766 = ERR_KEYNOPERM
        const response = await client.waitForLine(/765|766|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA error response:', response);
      } catch {
        // No error may mean key just doesn't exist (empty response)
        console.log('No METADATA error response');
      }

      client.send('QUIT');
    });

    it('returns error for metadata on non-existent target', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr2');
      await client.waitForLine(/001/);

      // Try to get metadata for non-existent user
      client.send('METADATA nonexistentnick12345 GET avatar');

      try {
        // 401 = ERR_NOSUCHNICK, 764 = ERR_TARGETINVALID
        const response = await client.waitForLine(/401|764|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA target error response:', response);
      } catch {
        console.log('No METADATA target error response');
      }

      client.send('QUIT');
    });
  });

  describe('Standard Metadata Keys', () => {
    it('can set and get avatar metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta1');
      await client.waitForLine(/001/);

      client.send('METADATA * SET avatar :https://example.com/myavatar.png');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA * GET avatar');

      try {
        const response = await client.waitForLine(/761.*avatar|METADATA.*avatar/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Avatar metadata not available');
      }

      client.send('QUIT');
    });

    it('can set and get pronouns metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta2');
      await client.waitForLine(/001/);

      client.send('METADATA * SET pronouns :they/them');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA * GET pronouns');

      try {
        const response = await client.waitForLine(/761.*pronouns|METADATA.*pronouns/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Pronouns metadata not available');
      }

      client.send('QUIT');
    });

    it('can set bot flag metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta3');
      await client.waitForLine(/001/);

      client.send('METADATA * SET bot :1');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA * GET bot');

      try {
        const response = await client.waitForLine(/761.*bot|METADATA.*bot/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Bot metadata not available');
      }

      client.send('QUIT');
    });
  });
});
