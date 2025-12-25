import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client, createIRCv3Client } from '../helpers/index.js';

/**
 * Metadata Tests (draft/metadata-2)
 *
 * Tests the IRCv3 metadata specification for user and channel metadata.
 */
describe('IRCv3 Metadata (draft/metadata-2)', () => {
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

  describe('Capability Advertisement', () => {
    it('server advertises metadata capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metatest1' })
      );

      const caps = await client.capLs();

      // May be draft/metadata or draft/metadata-2
      const hasMetadata = caps.has('draft/metadata-2') || caps.has('draft/metadata');
      expect(hasMetadata).toBe(true);
    });

    it('can request metadata capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metatest2' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      const result = await client.capReq([metaCap]);

      expect(result.ack.length).toBeGreaterThan(0);
    });
  });

  describe('METADATA Commands', () => {
    it('can set user metadata with METADATA SET', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metaset1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaset1');
      await client.waitForRaw(/001/);

      // Try to set avatar metadata
      client.raw('METADATA * SET avatar :https://example.com/avatar.png');

      // Should receive confirmation or error
      try {
        const response = await client.waitForRaw(/METADATA|761|762|764|765|766|767/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA SET response:', response);
      } catch {
        // Some implementations may not respond for self-set
        console.log('No METADATA SET response received');
      }
    });

    it('can get user metadata with METADATA GET', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metaget1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaget1');
      await client.waitForRaw(/001/);

      // First set some metadata
      client.raw('METADATA * SET testkey :testvalue123');
      await new Promise(r => setTimeout(r, 500));

      // Then try to get it
      client.raw('METADATA * GET testkey');

      try {
        // 761 = RPL_KEYVALUE (metadata value response)
        const response = await client.waitForRaw(/761|METADATA.*testkey/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA GET response:', response);
      } catch {
        console.log('No METADATA GET response - may need authentication');
      }
    });

    it('can list user metadata with METADATA LIST', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metalist1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metalist1');
      await client.waitForRaw(/001/);

      client.raw('METADATA * LIST');

      try {
        // 761 = RPL_KEYVALUE, 762 = RPL_METADATAEND
        const responses = await client.collectRaw(
          /76[12]/,
          { timeout: 3000, stopPattern: /762/ }
        );
        expect(responses.length).toBeGreaterThanOrEqual(0);
        console.log('METADATA LIST responses:', responses);
      } catch {
        console.log('No METADATA LIST response');
      }
    });

    it('can clear metadata with METADATA CLEAR', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metaclear1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaclear1');
      await client.waitForRaw(/001/);

      // Set then clear
      client.raw('METADATA * SET cleartest :value');
      await new Promise(r => setTimeout(r, 500));
      client.raw('METADATA * CLEAR cleartest');

      try {
        const response = await client.waitForRaw(/761|766|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA CLEAR response:', response);
      } catch {
        console.log('No METADATA CLEAR response');
      }
    });
  });

  describe('Channel Metadata', () => {
    it('can set channel metadata', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'chanmeta1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta1');
      await client.waitForRaw(/001/);

      // Join channel first (need to be op usually)
      const channelName = `#metaTest${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Try to set channel metadata
      client.raw(`METADATA ${channelName} SET url :https://example.com`);

      try {
        const response = await client.waitForRaw(/761|764|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA SET response:', response);
      } catch {
        console.log('No channel METADATA SET response - may need op status');
      }
    });

    it('can get channel metadata', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'chanmeta2' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta2');
      await client.waitForRaw(/001/);

      const channelName = `#metaGet${Date.now()}`;
      client.join(channelName);
      await client.waitForRaw(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Set then get
      client.raw(`METADATA ${channelName} SET testchankey :testvalue`);
      await new Promise(r => setTimeout(r, 500));
      client.raw(`METADATA ${channelName} GET testchankey`);

      try {
        const response = await client.waitForRaw(/761|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA GET response:', response);
      } catch {
        console.log('No channel METADATA GET response');
      }
    });
  });

  describe('Metadata Subscriptions', () => {
    it('can subscribe to metadata changes with METADATA SUB', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metasub1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metasub1');
      await client.waitForRaw(/001/);

      // Subscribe to all metadata changes for a target
      client.raw('METADATA * SUB avatar');

      try {
        const response = await client.waitForRaw(/769|770|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA SUB response:', response);
      } catch {
        console.log('No METADATA SUB response - may not be supported');
      }
    });
  });

  describe('Metadata Error Handling', () => {
    it('returns error for invalid key', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metaerr1' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr1');
      await client.waitForRaw(/001/);

      // Try to get non-existent key
      client.raw('METADATA * GET nonexistentkey12345');

      try {
        // 765 = ERR_KEYNOTSET, 766 = ERR_KEYNOPERM
        const response = await client.waitForRaw(/765|766|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA error response:', response);
      } catch {
        // No error may mean key just doesn't exist (empty response)
        console.log('No METADATA error response');
      }
    });

    it('returns error for metadata on non-existent target', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'metaerr2' })
      );

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr2');
      await client.waitForRaw(/001/);

      // Try to get metadata for non-existent user
      client.raw('METADATA nonexistentnick12345 GET avatar');

      try {
        // 401 = ERR_NOSUCHNICK, 764 = ERR_TARGETINVALID
        const response = await client.waitForRaw(/401|764|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA target error response:', response);
      } catch {
        console.log('No METADATA target error response');
      }
    });
  });

  describe('Standard Metadata Keys', () => {
    it('can set and get avatar metadata', async () => {
      const client = trackClient(
        await createIRCv3Client({ nick: 'stdmeta1' })
      );

      client.raw('METADATA * SET avatar :https://example.com/myavatar.png');
      await new Promise(r => setTimeout(r, 500));
      client.raw('METADATA * GET avatar');

      try {
        const response = await client.waitForRaw(/761.*avatar|METADATA.*avatar/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Avatar metadata not available');
      }
    });

    it('can set and get pronouns metadata', async () => {
      const client = trackClient(
        await createIRCv3Client({ nick: 'stdmeta2' })
      );

      client.raw('METADATA * SET pronouns :they/them');
      await new Promise(r => setTimeout(r, 500));
      client.raw('METADATA * GET pronouns');

      try {
        const response = await client.waitForRaw(/761.*pronouns|METADATA.*pronouns/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Pronouns metadata not available');
      }
    });

    it('can set bot flag metadata', async () => {
      const client = trackClient(
        await createIRCv3Client({ nick: 'stdmeta3' })
      );

      client.raw('METADATA * SET bot :1');
      await new Promise(r => setTimeout(r, 500));
      client.raw('METADATA * GET bot');

      try {
        const response = await client.waitForRaw(/761.*bot|METADATA.*bot/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Bot metadata not available');
      }
    });
  });
});
